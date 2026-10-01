// Type-checker truth for C#: rebuilds every compilation a real build ran (from the csc arguments captured with
// oracle-capture.targets, plus the files its source generators emitted) and resolves the callee name of every
// invocation and object creation with Roslyn's SemanticModel.GetSymbolInfo. A site is "in-repo" when a source
// declaration is inside the corpus, "external" when every declaration is in metadata or outside it (generated code,
// package sources), and undecided when Roslyn binds no symbol.
// usage: dotnet TruthCSharp.dll --root <checkout> --build <build copy> --output <truth.json> [--corpus <id>]
using System.Collections.Immutable;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

var opts = new SortedDictionary<string, string>(StringComparer.Ordinal);
for (var i = 0; i + 1 < args.Length; i += 2) opts[args[i].TrimStart('-')] = args[i + 1];
if (!opts.ContainsKey("root") || !opts.ContainsKey("build") || !opts.ContainsKey("output"))
{
    Console.Error.WriteLine("usage: TruthCSharp --root <checkout> --build <build copy> --output <truth.json> [--corpus <id>]");
    return 2;
}
var root = Path.GetFullPath(opts["root"]).TrimEnd(Path.DirectorySeparatorChar);
var build = Path.GetFullPath(opts["build"]).TrimEnd(Path.DirectorySeparatorChar);

string? CheckoutPath(string? file)
{
    if (string.IsNullOrEmpty(file)) return null;
    var full = Path.GetFullPath(file);
    if (!full.StartsWith(build + Path.DirectorySeparatorChar, StringComparison.Ordinal)) return null;
    var rel = Path.GetRelativePath(build, full).Replace(Path.DirectorySeparatorChar, '/');
    if (rel.StartsWith("artifacts/", StringComparison.Ordinal) || rel.Split('/').Any(part => part is "obj" or "bin")) return null;
    return File.Exists(Path.Combine(root, rel)) ? rel : null;
}

Guid? Mvid(string path)
{
    if (!File.Exists(path)) return null;
    using var stream = File.OpenRead(path);
    using var pe = new PEReader(stream);
    if (!pe.HasMetadata) return null;
    var reader = pe.GetMetadataReader();
    return reader.GetGuid(reader.GetModuleDefinition().Mvid);
}

var captures = Directory.EnumerateFiles(build, "oracle-csc.txt", SearchOption.AllDirectories).OrderBy(p => p, StringComparer.Ordinal).ToList();
var units = new List<Unit>();
foreach (var capture in captures)
{
    var lines = File.ReadAllLines(capture);
    var parsed = CSharpCommandLineParser.Default.Parse(lines.Skip(2), lines[0], sdkDirectory: null);
    foreach (var error in parsed.Errors) Console.Error.WriteLine($"{Path.GetRelativePath(build, capture)}: {error.GetMessage()}");
    var output = Path.Combine(parsed.OutputDirectory, parsed.OutputFileName ?? "");
    units.Add(new Unit(Path.GetRelativePath(build, capture).Replace(Path.DirectorySeparatorChar, '/'), lines[0], lines[1], parsed, Mvid(output), parsed.OutputRefFilePath is null ? null : Mvid(parsed.OutputRefFilePath)));
}
// A project reference names the referenced project's built assembly or its reference assembly; both carry that
// build's module version id, which maps the reference back to the project's compilation.
var byMvid = new Dictionary<Guid, Unit>();
foreach (var unit in units)
    foreach (var mvid in new[] { unit.Mvid, unit.RefMvid })
        if (mvid is not null) byMvid.TryAdd(mvid.Value, unit);

var compilations = new Dictionary<Unit, CSharpCompilation>();
CSharpCompilation Compile(Unit unit)
{
    if (compilations.TryGetValue(unit, out var done)) return done;
    var parseOptions = unit.Args.ParseOptions;
    var trees = new List<SyntaxTree>();
    foreach (var source in unit.Args.SourceFiles)
    {
        using var stream = File.OpenRead(source.Path);
        trees.Add(CSharpSyntaxTree.ParseText(SourceText.From(stream, Encoding.UTF8), parseOptions, source.Path));
    }
    if (Directory.Exists(unit.GeneratedDir))
    {
        foreach (var generated in Directory.EnumerateFiles(unit.GeneratedDir, "*.cs", SearchOption.AllDirectories).OrderBy(p => p, StringComparer.Ordinal))
        {
            using var stream = File.OpenRead(generated);
            trees.Add(CSharpSyntaxTree.ParseText(SourceText.From(stream, Encoding.UTF8), parseOptions, generated));
        }
    }
    var references = new List<MetadataReference>();
    foreach (var reference in unit.Args.MetadataReferences)
    {
        var path = Path.GetFullPath(reference.Reference, unit.ProjectDir);
        var mvid = Mvid(path);
        if (mvid is not null && byMvid.TryGetValue(mvid.Value, out var project) && project != unit)
            references.Add(Compile(project).ToMetadataReference(reference.Properties.Aliases, reference.Properties.EmbedInteropTypes));
        else
            references.Add(MetadataReference.CreateFromFile(path, reference.Properties));
    }
    var options = unit.Args.CompilationOptions.WithStrongNameProvider(new DesktopStrongNameProvider(ImmutableArray.Create(unit.ProjectDir)));
    var compilation = CSharpCompilation.Create(unit.Args.CompilationName, trees, references, options);
    compilations[unit] = compilation;
    return compilation;
}

// A file compiled by several projects (linked sources, multi-version analyzer projects) is scored once, in the
// project whose folder holds it, else in the first capture in path order.
var home = new Dictionary<string, Unit>(StringComparer.Ordinal);
foreach (var unit in units)
{
    foreach (var source in unit.Args.SourceFiles)
    {
        var file = CheckoutPath(source.Path);
        if (file is null) continue;
        var inProject = Path.GetFullPath(source.Path).StartsWith(unit.ProjectDir + Path.DirectorySeparatorChar, StringComparison.Ordinal);
        if (!home.TryGetValue(file, out var current) || (inProject && !Path.GetFullPath(Path.Combine(build, file)).StartsWith(current.ProjectDir + Path.DirectorySeparatorChar, StringComparison.Ordinal)))
            home[file] = unit;
    }
}
var entries = new List<Entry>();
var claimedFiles = new HashSet<string>(StringComparer.Ordinal);
int callSites = 0, complexCallee = 0, noSymbol = 0, externalOnly = 0, inRepoDecided = 0, compileErrors = 0;
var unitStats = new List<object>();
foreach (var unit in units)
{
    var compilation = Compile(unit);
    var errors = compilation.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
    compileErrors += errors.Count;
    foreach (var error in errors.Take(20)) Console.Error.WriteLine($"{unit.Capture}: {error}");
    var files = 0;
    foreach (var tree in compilation.SyntaxTrees)
    {
        var file = CheckoutPath(tree.FilePath);
        if (file is null || home.GetValueOrDefault(file) != unit || !claimedFiles.Add(file)) continue;
        files += 1;
        var model = compilation.GetSemanticModel(tree);
        foreach (var node in tree.GetRoot().DescendantNodes())
        {
            SimpleNameSyntax? name;
            ISymbol? symbol;
            if (node is InvocationExpressionSyntax invocation)
            {
                callSites += 1;
                name = invocation.Expression switch
                {
                    SimpleNameSyntax simple => simple,
                    MemberAccessExpressionSyntax member => member.Name,
                    MemberBindingExpressionSyntax binding => binding.Name,
                    _ => null,
                };
                if (name is null) { complexCallee += 1; continue; }
                symbol = model.GetSymbolInfo(name).Symbol;
            }
            else if (node is ObjectCreationExpressionSyntax creation)
            {
                callSites += 1;
                name = creation.Type switch
                {
                    SimpleNameSyntax simple => simple,
                    QualifiedNameSyntax qualified => qualified.Right,
                    AliasQualifiedNameSyntax alias => alias.Name,
                    _ => null,
                };
                if (name is null) { complexCallee += 1; continue; }
                symbol = model.GetSymbolInfo(creation).Symbol;
                if (symbol is IMethodSymbol { IsImplicitlyDeclared: true } implicitConstructor) symbol = implicitConstructor.ContainingType;
                symbol ??= model.GetSymbolInfo(name).Symbol;
            }
            else continue;
            var line = name.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
            if (symbol is null) { noSymbol += 1; continue; }
            if (symbol is IMethodSymbol method)
            {
                method = method.ReducedFrom ?? method;
                symbol = method.OriginalDefinition;
            }
            else symbol = symbol.OriginalDefinition;
            var declarations = symbol.Locations.ToList();
            if (symbol is IMethodSymbol { PartialImplementationPart: { } implementation }) declarations.AddRange(implementation.Locations);
            if (symbol is IMethodSymbol { PartialDefinitionPart: { } definition }) declarations.AddRange(definition.Locations);
            var defs = declarations.Where(l => l.IsInSource)
                .Select(l => (File: CheckoutPath(l.SourceTree!.FilePath), Line: l.GetLineSpan().StartLinePosition.Line + 1))
                .Where(d => d.File is not null)
                .Select(d => new Def(d.File!, d.Line))
                .Distinct()
                .OrderBy(d => d.File, StringComparer.Ordinal).ThenBy(d => d.Line)
                .ToList();
            var column = name.GetLocation().GetLineSpan().StartLinePosition.Character;
            if (defs.Count == 0) { externalOnly += 1; entries.Add(new Entry(file, line, name.Identifier.ValueText, "external", defs, column)); }
            else { inRepoDecided += 1; entries.Add(new Entry(file, line, name.Identifier.ValueText, "in-repo", defs, column)); }
        }
    }
    unitStats.Add(new { unit = unit.Capture, assembly = unit.Args.CompilationName, files, compileErrors = errors.Count });
}
entries.Sort((a, b) =>
{
    var c = string.CompareOrdinal(a.File, b.File);
    if (c != 0) return c;
    c = a.Line.CompareTo(b.Line);
    if (c != 0) return c;
    c = a.Column.CompareTo(b.Column);
    return c != 0 ? c : string.CompareOrdinal(a.Name, b.Name);
});

var roslynVersion = typeof(CSharpCompilation).Assembly.GetName().Version?.ToString() ?? "unknown";
var result = new Dictionary<string, object?>
{
    ["schemaVersion"] = 1,
    ["oracle"] = "roslyn",
    ["oracleVersion"] = $"Microsoft.CodeAnalysis.CSharp {roslynVersion}",
    ["corpus"] = opts.GetValueOrDefault("corpus"),
    ["method"] = "every csc invocation of a real build is replayed from its captured arguments (sources, references, defines, language version) with the files its source generators emitted, and project references are replaced by the referenced project's compilation; for every InvocationExpressionSyntax the callee name (a simple name, or the name of a member access or conditional access) and for every ObjectCreationExpressionSyntax the constructor (the type when the constructor is implicit) is bound with SemanticModel.GetSymbolInfo; reduced extension methods and generic instantiations are mapped to their definitions; a site is 'in-repo' when a source declaration is inside the corpus, 'external' when every declaration is in metadata or outside the corpus, and undecided when no symbol binds; a file compiled by several projects is scored once, in the project whose folder holds it, else in the first capture in path order",
    ["stats"] = new { callSites, complexCallee, noSymbol, externalOnly, inRepoDecided, files = claimedFiles.Count, compilations = units.Count, compileErrors },
    ["compilations"] = unitStats,
    ["entries"] = entries.Select(e => new { file = e.File, line = e.Line, name = e.Name, verdict = e.Verdict, defs = e.Defs.Select(d => new { file = d.File, line = d.Line }) }),
};
var json = JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
using (var stream = new FileStream(opts["output"], FileMode.CreateNew, FileAccess.Write))
using (var writer = new StreamWriter(stream, new UTF8Encoding(false)))
{
    writer.Write(json);
    writer.Write('\n');
}
Console.WriteLine(JsonSerializer.Serialize(new { oracle = "roslyn", version = roslynVersion, callSites, complexCallee, noSymbol, externalOnly, inRepoDecided, files = claimedFiles.Count, compilations = units.Count, compileErrors }));
return 0;

record Unit(string Capture, string ProjectDir, string GeneratedDir, CSharpCommandLineArguments Args, Guid? Mvid, Guid? RefMvid);
record Def(string File, int Line);
record Entry(string File, int Line, string Name, string Verdict, List<Def> Defs, int Column);
