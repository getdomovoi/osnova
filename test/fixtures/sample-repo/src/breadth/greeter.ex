defmodule Greeter do
  def greet(name), do: format(name)
  defp format(name), do: String.upcase(name)
end
