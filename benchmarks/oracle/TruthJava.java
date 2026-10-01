// Type-checker truth for Java: one javac task per build module (the javac Compiler Tree API, attribution only)
// resolves every method invocation and `new` expression to its declaration. A site is "in-repo" when the declaration
// is inside the corpus, "external" when it is outside it (JDK, classpath jars, generated sources), and undecided when
// javac resolves no method, constructor or type.
// usage: java --add-exports jdk.compiler/com.sun.tools.javac.tree=ALL-UNNAMED TruthJava.java --root <checkout>
//        --units <units.properties> --build <maven build copy> --output <truth.json> [--corpus <id>]
import com.sun.source.tree.AnnotatedTypeTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.ExpressionTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.LineMap;
import com.sun.source.tree.MemberSelectTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.NewClassTree;
import com.sun.source.tree.ParameterizedTypeTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;
import com.sun.tools.javac.tree.JCTree;
import java.io.File;
import java.io.IOException;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Properties;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.stream.Stream;
import javax.lang.model.element.Element;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.TypeElement;
import javax.lang.model.type.TypeKind;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.ForwardingJavaFileManager;
import javax.tools.JavaFileManager;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.StandardLocation;
import javax.tools.ToolProvider;

public class TruthJava {
  record Def(String file, long line) {}

  record Entry(String file, long line, long column, String name, String verdict, List<Def> defs) {}

  static int callSites, synthetic, noElement, externalOnly, inRepoDecided, files, compileErrors;

  public static void main(String[] args) throws Exception {
    TreeMap<String, String> opts = new TreeMap<>();
    for (int i = 0; i + 1 < args.length; i += 2) opts.put(args[i].replaceFirst("^--", ""), args[i + 1]);
    if (!opts.containsKey("root") || !opts.containsKey("units") || !opts.containsKey("output")) {
      System.err.println("usage: TruthJava.java --root <checkout> --units <units.properties> --build <maven build copy> --output <truth.json> [--corpus <id>]");
      System.exit(2);
    }
    Path root = Paths.get(opts.get("root")).toRealPath();
    Path build = opts.containsKey("build") ? Paths.get(opts.get("build")).toRealPath() : null;
    Properties units = new Properties();
    try (Reader reader = Files.newBufferedReader(Paths.get(opts.get("units")), StandardCharsets.UTF_8)) {
      units.load(reader);
    }
    TreeSet<String> modules = new TreeSet<>();
    for (String key : units.stringPropertyNames()) if (key.endsWith(".sources")) modules.add(key.substring(0, key.length() - ".sources".length()));

    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    List<Entry> entries = new ArrayList<>();
    for (String module : modules) {
      List<Path> sourceRoots = split(units.getProperty(module + ".sources"), root);
      List<Path> sourcePath = new ArrayList<>(sourceRoots);
      sourcePath.addAll(split(units.getProperty(module + ".sourcepath"), root));
      List<Path> classPath = new ArrayList<>();
      if (build != null) {
        sourcePath.addAll(split(units.getProperty(module + ".generated"), build.resolve(module)));
        Path cp = build.resolve(module).resolve("cp.txt");
        if (Files.exists(cp)) {
          for (String jar : Files.readString(cp).trim().split(File.pathSeparator)) if (!jar.isEmpty()) classPath.add(Paths.get(jar));
        }
      }
      List<Path> sources = new ArrayList<>();
      for (Path dir : sourceRoots) {
        if (!Files.isDirectory(dir)) continue;
        try (Stream<Path> walk = Files.walk(dir)) {
          walk.filter(p -> p.toString().endsWith(".java") && !p.getFileName().toString().equals("module-info.java")).forEach(sources::add);
        }
      }
      sources.sort(Comparator.naturalOrder());
      files += sources.size();
      StandardJavaFileManager fm = compiler.getStandardFileManager(null, Locale.ROOT, StandardCharsets.UTF_8);
      fm.setLocationFromPaths(StandardLocation.SOURCE_PATH, sourcePath.stream().filter(Files::isDirectory).toList());
      fm.setLocationFromPaths(StandardLocation.CLASS_PATH, classPath);
      DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
      List<String> options = List.of("-proc:none", "-implicit:none", "-nowarn", "-Xlint:none", "-encoding", "UTF-8", "-Xmaxerrs", "1000000", "-XDshould-stop.ifError=FLOW");
      // A module-info.java on the source path would switch javac to module mode; every module compiles on the classpath.
      JavaFileManager classPathMode = new ForwardingJavaFileManager<>(fm) {
        @Override
        public JavaFileObject getJavaFileForInput(Location location, String className, JavaFileObject.Kind kind) throws IOException {
          return location == StandardLocation.SOURCE_PATH && className.equals("module-info") ? null : super.getJavaFileForInput(location, className, kind);
        }
      };
      JavacTask task = (JavacTask) compiler.getTask(null, classPathMode, diagnostics, options, null, fm.getJavaFileObjectsFromPaths(sources));
      Iterable<? extends CompilationUnitTree> compilationUnits = task.parse();
      task.analyze();
      for (Diagnostic<? extends JavaFileObject> d : diagnostics.getDiagnostics()) {
        if (d.getKind() != Diagnostic.Kind.ERROR) continue;
        compileErrors += 1;
        System.err.println(module + ": " + (d.getSource() == null ? "" : rel(root, Paths.get(d.getSource().toUri()).toRealPath()) + ":" + d.getLineNumber() + ": ") + d.getMessage(Locale.ROOT).lines().findFirst().orElse(""));
      }
      Trees trees = Trees.instance(task);
      for (CompilationUnitTree cu : compilationUnits) scan(cu, trees, root, entries);
      fm.close();
    }
    entries.sort(Comparator.comparing(Entry::file).thenComparingLong(Entry::line).thenComparingLong(Entry::column).thenComparing(Entry::name));

    StringBuilder out = new StringBuilder();
    out.append("{\n  \"schemaVersion\": 1,\n  \"oracle\": \"javac\",\n");
    out.append("  \"oracleVersion\": ").append(json(Runtime.version().toString())).append(",\n");
    out.append("  \"corpus\": ").append(opts.containsKey("corpus") ? json(opts.get("corpus")) : "null").append(",\n");
    out.append("  \"method\": ").append(json("one javac task per build module (JavacTask.parse and analyze, attribution continued past errors) over the module's source roots, with sibling modules' sources and generated sources on the sourcepath and the module's Maven test classpath; for every MethodInvocationTree the method select, and for every NewClassTree the class identifier, is resolved with Trees.getElement (the constructor, or the named type for an anonymous class); a site is 'in-repo' when the declaration's source file is inside the corpus, 'external' when it is a class file or a source outside the corpus, and undecided when javac resolves no element; calls javac inserts itself (implicit super(), enum constant creation) are skipped")).append(",\n");
    out.append("  \"stats\": { \"callSites\": ").append(callSites).append(", \"synthetic\": ").append(synthetic).append(", \"noElement\": ").append(noElement)
        .append(", \"externalOnly\": ").append(externalOnly).append(", \"inRepoDecided\": ").append(inRepoDecided).append(", \"files\": ").append(files)
        .append(", \"modules\": ").append(modules.size()).append(", \"compileErrors\": ").append(compileErrors).append(" },\n");
    out.append("  \"entries\": [");
    for (int i = 0; i < entries.size(); i++) {
      Entry e = entries.get(i);
      out.append(i == 0 ? "\n" : ",\n").append("    { \"file\": ").append(json(e.file())).append(", \"line\": ").append(e.line())
          .append(", \"name\": ").append(json(e.name())).append(", \"verdict\": ").append(json(e.verdict())).append(", \"defs\": [");
      for (int j = 0; j < e.defs().size(); j++) {
        Def d = e.defs().get(j);
        out.append(j == 0 ? "" : ", ").append("{ \"file\": ").append(json(d.file())).append(", \"line\": ").append(d.line()).append(" }");
      }
      out.append("] }");
    }
    out.append(entries.isEmpty() ? "]\n}\n" : "\n  ]\n}\n");
    Files.writeString(Paths.get(opts.get("output")), out, StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
    System.out.println("{\"oracle\":\"javac\",\"version\":" + json(Runtime.version().toString()) + ",\"callSites\":" + callSites + ",\"synthetic\":" + synthetic
        + ",\"noElement\":" + noElement + ",\"externalOnly\":" + externalOnly + ",\"inRepoDecided\":" + inRepoDecided + ",\"files\":" + files + ",\"compileErrors\":" + compileErrors + "}");
  }

  static List<Path> split(String value, Path base) {
    List<Path> paths = new ArrayList<>();
    if (value == null) return paths;
    for (String part : value.split(",")) if (!part.isBlank()) paths.add(base.resolve(part.trim()).normalize());
    return paths;
  }

  @SuppressWarnings("removal")
  static void scan(CompilationUnitTree cu, Trees trees, Path root, List<Entry> entries) throws IOException {
    SourcePositions positions = trees.getSourcePositions();
    String text = cu.getSourceFile().getCharContent(true).toString();
    LineMap lines = cu.getLineMap();
    String file = rel(root, Paths.get(cu.getSourceFile().toUri()).toRealPath());
    new TreePathScanner<Void, Void>() {
      @Override
      public Void visitMethodInvocation(MethodInvocationTree node, Void unused) {
        ExpressionTree select = node.getMethodSelect();
        String name = select instanceof MemberSelectTree member ? member.getIdentifier().toString() : select instanceof IdentifierTree id ? id.getName().toString() : null;
        record(select, name, new TreePath(getCurrentPath(), select));
        return super.visitMethodInvocation(node, unused);
      }

      @Override
      public Void visitNewClass(NewClassTree node, Void unused) {
        TreePath path = new TreePath(getCurrentPath(), node.getIdentifier());
        ExpressionTree type = node.getIdentifier();
        while (type instanceof ParameterizedTypeTree || type instanceof AnnotatedTypeTree) {
          type = type instanceof ParameterizedTypeTree p ? (ExpressionTree) p.getType() : ((AnnotatedTypeTree) type).getUnderlyingType();
          path = new TreePath(path, type);
        }
        String name = type instanceof MemberSelectTree member ? member.getIdentifier().toString() : type instanceof IdentifierTree id ? id.getName().toString() : null;
        record(type, name, node.getClassBody() == null ? getCurrentPath() : path);
        return super.visitNewClass(node, unused);
      }

      void record(ExpressionTree nameTree, String name, TreePath resolve) {
        if (name == null) return;
        long end = positions.getEndPosition(cu, nameTree);
        long start = nameTree instanceof MemberSelectTree ? end - name.length() : positions.getStartPosition(cu, nameTree);
        if (end == javax.tools.Diagnostic.NOPOS || start < 0 || !text.startsWith(name, (int) start)) {
          synthetic += 1;
          return;
        }
        callSites += 1;
        long line = lines.getLineNumber(start), column = lines.getColumnNumber(start);
        Element element = trees.getElement(resolve);
        if (element == null || !(element instanceof ExecutableElement || element instanceof TypeElement) || element.asType().getKind() == TypeKind.ERROR) {
          noElement += 1;
          return;
        }
        TreePath declaration = trees.getPath(element);
        if (declaration != null) {
          try {
            Path declared = Paths.get(declaration.getCompilationUnit().getSourceFile().toUri()).toRealPath();
            if (declared.startsWith(root)) {
              long declaredLine = declaration.getCompilationUnit().getLineMap().getLineNumber(((JCTree) declaration.getLeaf()).pos);
              inRepoDecided += 1;
              entries.add(new Entry(file, line, column, name, "in-repo", List.of(new Def(rel(root, declared), declaredLine))));
              return;
            }
          } catch (IOException e) {
            throw new RuntimeException(e);
          }
        }
        externalOnly += 1;
        entries.add(new Entry(file, line, column, name, "external", List.of()));
      }
    }.scan(cu, null);
  }

  static String rel(Path root, Path file) {
    return root.relativize(file).toString().replace(File.separatorChar, '/');
  }

  static String json(String value) {
    StringBuilder sb = new StringBuilder("\"");
    for (char c : value.toCharArray()) {
      if (c == '"' || c == '\\') sb.append('\\').append(c);
      else if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
      else sb.append(c);
    }
    return sb.append('"').toString();
  }
}
