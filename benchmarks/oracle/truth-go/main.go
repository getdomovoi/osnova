// Type-checker truth for Go: go/packages loads every package of the corpus (tests included) and go/types resolves
// the callee identifier of every call expression. A site is "in-repo" when the callee's declaration is inside the
// corpus, "external" when it is outside it (standard library, module cache, builtins), and undecided when go/types
// records no object for the identifier.
// usage: go run . -root <checkout> -output <truth.json> [-corpus <id>] [-goos darwin,windows]
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"sort"
	"strings"

	"golang.org/x/tools/go/packages"
)

type def struct {
	File string `json:"file"`
	Line int    `json:"line"`
}

type entry struct {
	File    string `json:"file"`
	Line    int    `json:"line"`
	Name    string `json:"name"`
	Verdict string `json:"verdict"`
	Defs    []def  `json:"defs"`
	column  int
}

type stats struct {
	CallSites     int `json:"callSites"`
	ComplexCallee int `json:"complexCallee"`
	NoObject      int `json:"noObject"`
	ExternalOnly  int `json:"externalOnly"`
	InRepoDecided int `json:"inRepoDecided"`
	Files         int `json:"files"`
	Packages      int `json:"packages"`
	TypeErrors    int `json:"typeErrors"`
}

type truth struct {
	SchemaVersion int      `json:"schemaVersion"`
	Oracle        string   `json:"oracle"`
	OracleVersion string   `json:"oracleVersion"`
	Corpus        *string  `json:"corpus"`
	Method        string   `json:"method"`
	BuildTargets  []string `json:"buildTargets"`
	Stats         stats    `json:"stats"`
	Entries       []entry  `json:"entries"`
}

func main() {
	rootFlag := flag.String("root", "", "corpus checkout")
	output := flag.String("output", "", "truth file to write")
	corpus := flag.String("corpus", "", "corpus id")
	goos := flag.String("goos", "", "comma-separated GOOS values to load in turn (default: the host)")
	flag.Parse()
	if *rootFlag == "" || *output == "" {
		fmt.Fprintln(os.Stderr, "usage: go run . -root <checkout> -output <truth.json> [-corpus <id>] [-goos darwin,windows]")
		os.Exit(2)
	}
	root, err := filepath.Abs(*rootFlag)
	check(err)
	root, err = filepath.EvalSymlinks(root)
	check(err)

	rel := func(file string) (string, bool) {
		if resolved, err := filepath.EvalSymlinks(file); err == nil {
			file = resolved
		}
		r, err := filepath.Rel(root, file)
		if err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
			return "", false
		}
		r = filepath.ToSlash(r)
		if strings.HasPrefix(r, "vendor/") || strings.Contains(r, "/vendor/") {
			return "", false
		}
		return r, true
	}

	targets := []string{runtime.GOOS}
	if *goos != "" {
		targets = strings.Split(*goos, ",")
	}
	seen := map[string]bool{}
	files := map[string]bool{}
	pkgIDs := map[string]bool{}
	var entries []entry
	var st stats
	for _, target := range targets {
		cfg := &packages.Config{
			Mode:  packages.NeedName | packages.NeedFiles | packages.NeedSyntax | packages.NeedTypes | packages.NeedTypesInfo | packages.NeedImports | packages.NeedDeps,
			Dir:   root,
			Tests: true,
			Env:   append(os.Environ(), "GOOS="+target, "CGO_ENABLED=0", "GOFLAGS=-mod=readonly"),
		}
		pkgs, err := packages.Load(cfg, "./...")
		check(err)
		sort.Slice(pkgs, func(i, j int) bool { return pkgs[i].ID < pkgs[j].ID })
		for _, pkg := range pkgs {
			if pkg.TypesInfo == nil {
				continue
			}
			pkgIDs[pkg.ID] = true
			st.TypeErrors += len(pkg.TypeErrors)
			for _, file := range pkg.Syntax {
				fileName := pkg.Fset.Position(file.Pos()).Filename
				caller, ok := rel(fileName)
				if !ok {
					continue
				}
				files[caller] = true
				ast.Inspect(file, func(n ast.Node) bool {
					call, ok := n.(*ast.CallExpr)
					if !ok {
						return true
					}
					pos := pkg.Fset.Position(call.Lparen)
					fun := ast.Unparen(call.Fun)
					switch f := fun.(type) {
					case *ast.IndexExpr:
						fun = ast.Unparen(f.X)
					case *ast.IndexListExpr:
						fun = ast.Unparen(f.X)
					}
					var id *ast.Ident
					switch f := fun.(type) {
					case *ast.Ident:
						id = f
					case *ast.SelectorExpr:
						id = f.Sel
					}
					key := fmt.Sprintf("%s:%d:%d", caller, pos.Line, pos.Column)
					if seen[key] {
						return true
					}
					seen[key] = true
					st.CallSites++
					if id == nil {
						st.ComplexCallee++
						return true
					}
					at := pkg.Fset.Position(id.Pos())
					obj := pkg.TypesInfo.Uses[id]
					if obj == nil {
						st.NoObject++
						return true
					}
					e := entry{File: caller, Line: at.Line, Name: id.Name, column: at.Column, Defs: []def{}}
					declared := obj.Pos()
					if !declared.IsValid() {
						e.Verdict = "external"
						st.ExternalOnly++
					} else if file, ok := rel(pkg.Fset.Position(declared).Filename); ok {
						e.Verdict = "in-repo"
						e.Defs = []def{{File: file, Line: pkg.Fset.Position(declared).Line}}
						st.InRepoDecided++
					} else {
						e.Verdict = "external"
						st.ExternalOnly++
					}
					entries = append(entries, e)
					return true
				})
			}
		}
	}
	sort.SliceStable(entries, func(i, j int) bool {
		a, b := entries[i], entries[j]
		if a.File != b.File {
			return a.File < b.File
		}
		if a.Line != b.Line {
			return a.Line < b.Line
		}
		if a.column != b.column {
			return a.column < b.column
		}
		return a.Name < b.Name
	})
	st.Files = len(files)
	st.Packages = len(pkgIDs)

	toolsVersion := "unknown"
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			if dep.Path == "golang.org/x/tools" {
				toolsVersion = dep.Version
			}
		}
	}
	var corpusID *string
	if *corpus != "" {
		corpusID = corpus
	}
	result := truth{
		SchemaVersion: 1,
		Oracle:        "go/types",
		OracleVersion: runtime.Version() + " (golang.org/x/tools " + toolsVersion + ")",
		Corpus:        corpusID,
		Method:        "golang.org/x/tools/go/packages loads ./... with tests for each listed GOOS; for every ast.CallExpr the callee identifier (a name, the selector of a qualified or method call, generic instantiation stripped) is resolved with types.Info.Uses; a site is 'in-repo' when the object is declared inside the corpus (outside vendor/), 'external' when it is declared outside it or is a builtin, and undecided when no object is recorded; calls through any other callee expression are counted but not listed",
		BuildTargets:  targets,
		Stats:         st,
		Entries:       entries,
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	check(enc.Encode(result))
	out, err := os.OpenFile(*output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	check(err)
	_, err = out.Write(buf.Bytes())
	check(err)
	check(out.Close())
	summary, _ := json.Marshal(map[string]any{"oracle": result.Oracle, "version": result.OracleVersion, "stats": st})
	fmt.Println(string(summary))
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
