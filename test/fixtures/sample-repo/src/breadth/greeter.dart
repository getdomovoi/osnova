class Greeter {
  String greet(String name) => format(name);
  String format(String name) => name.toUpperCase();
}
String run() => Greeter().greet("x");
