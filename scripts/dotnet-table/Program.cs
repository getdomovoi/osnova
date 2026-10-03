using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Collections.Generic;
var types = new (string Key, Type Type)[] {
  ("System.Object", typeof(object)), ("System.String", typeof(string)), ("System.Boolean", typeof(bool)), ("System.Char", typeof(char)),
  ("System.SByte", typeof(sbyte)), ("System.Byte", typeof(byte)), ("System.Int16", typeof(short)), ("System.UInt16", typeof(ushort)),
  ("System.Int32", typeof(int)), ("System.UInt32", typeof(uint)), ("System.Int64", typeof(long)), ("System.UInt64", typeof(ulong)),
  ("System.Single", typeof(float)), ("System.Double", typeof(double)), ("System.Decimal", typeof(decimal)),
  ("System.DateTime", typeof(DateTime)), ("System.DateOnly", typeof(DateOnly)), ("System.TimeOnly", typeof(TimeOnly)),
  ("System.TimeSpan", typeof(TimeSpan)), ("System.DateTimeOffset", typeof(DateTimeOffset)), ("System.Guid", typeof(Guid)),
  ("System.Enum", typeof(Enum)), ("System.Array", typeof(Array)), ("System.Nullable`1", typeof(Nullable<>)), ("System.ValueType", typeof(ValueType)),
};
const BindingFlags flags = BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.FlattenHierarchy;
static bool Skip(string n) => n.Contains('.') || n.StartsWith("op_") || n.StartsWith("get_") || n.StartsWith("set_") || n.StartsWith("add_") || n.StartsWith("remove_");
var members = new SortedDictionary<string, string[]>(StringComparer.Ordinal);
foreach (var (key, type) in types)
  members[key] = type.GetMembers(flags).Where(m => m.MemberType != MemberTypes.Constructor && m.MemberType != MemberTypes.NestedType && !Skip(m.Name)).Select(m => m.Name).Distinct().OrderBy(n => n, StringComparer.Ordinal).ToArray();
// Extension methods every shared-framework assembly declares, by namespace of the declaring static class.
var dir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
var extensions = new SortedDictionary<string, SortedSet<string>>(StringComparer.Ordinal);
var unreadable = new List<string>();
// Every exported top-level type, by namespace: its name with generic arity, its kind (c class, C sealed class, s struct,
// r ref struct, e enum, i interface, d delegate), + when it declares an implicit conversion, and < its base class when a
// class derives from one other than System.Object.
var kinds = new SortedDictionary<string, SortedSet<string>>(StringComparer.Ordinal);
foreach (var file in Directory.GetFiles(dir, "*.dll").OrderBy(f => f, StringComparer.Ordinal)) {
  Assembly assembly;
  if (Path.GetFileName(file) == "System.Private.CoreLib.dll") assembly = typeof(object).Assembly;
  else try { assembly = Assembly.LoadFrom(file); } catch { unreadable.Add(Path.GetFileName(file)); continue; }
  Type[] all;
  try { all = assembly.GetExportedTypes(); } catch { unreadable.Add(Path.GetFileName(file)); continue; }
  foreach (var type in all) {
    if (!type.IsNested) {
      var kind = type.IsEnum ? "e" : type.IsValueType ? (type.IsByRefLike ? "r" : "s") : type.IsInterface ? "i" : typeof(Delegate).IsAssignableFrom(type) ? "d" : type.IsSealed ? "C" : "c";
      var implicitConversion = type.GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly).Any(m => m.Name == "op_Implicit") ? "+" : "";
      var baseType = type.IsClass && type.BaseType != null && type.BaseType != typeof(object) && kind != "d"
        ? "<" + (type.BaseType.IsGenericType ? type.BaseType.GetGenericTypeDefinition() : type.BaseType).FullName : "";
      var space = type.Namespace ?? "";
      if (!kinds.TryGetValue(space, out var entries)) kinds[space] = entries = new SortedSet<string>(StringComparer.Ordinal);
      entries.Add(type.Name + ":" + kind + implicitConversion + baseType);
    }
    if (!(type.IsAbstract && type.IsSealed)) continue;
    foreach (var method in type.GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly)) {
      if (!method.IsDefined(typeof(ExtensionAttribute), false)) continue;
      var ns = type.Namespace ?? "";
      if (!extensions.TryGetValue(ns, out var set)) extensions[ns] = set = new SortedSet<string>(StringComparer.Ordinal);
      set.Add(method.Name);
    }
  }
}
Console.WriteLine(JsonSerializer.Serialize(new { runtime = Environment.Version.ToString(), members, extensions = extensions.ToDictionary(e => e.Key, e => e.Value.ToArray()), kinds = kinds.ToDictionary(e => e.Key, e => e.Value.ToArray()), unreadable }));
