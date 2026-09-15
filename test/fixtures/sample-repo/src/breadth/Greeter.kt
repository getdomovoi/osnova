package app
class Greeter {
  fun greet(name: String): String = format(name)
  private fun format(name: String): String = name.uppercase()
}
fun run(): String = Greeter().greet("x")
