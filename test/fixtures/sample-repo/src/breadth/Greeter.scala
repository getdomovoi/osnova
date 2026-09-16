package app
object Runner { def run(): String = new Greeter().greet("x") }
class Greeter {
  def greet(name: String): String = format(name)
  private def format(name: String): String = name.toUpperCase
}
trait Named { def name: String }
