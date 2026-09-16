defmodule Greeter do
  def greet(name), do: format(name)
  def greet_safe(name) when is_binary(name), do: format(name)

  def run do
    greet("world")
  end

  defp format(name), do: String.upcase(name)
end
