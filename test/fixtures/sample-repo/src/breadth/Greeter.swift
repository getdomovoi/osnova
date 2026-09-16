struct Point { var x: Int; var y: Int }
class Greeter {
  func greet(_ name: String) -> String { return format(name) }
  func format(_ name: String) -> String { return name.uppercased() }
}
func run() -> String { return Greeter().greet("x") }
