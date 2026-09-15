module Greeting
  class Greeter
    def greet(name)
      format_name(name)
    end
    def format_name(name)
      name.upcase
    end
  end
end
def run
  Greeting::Greeter.new.greet("x")
end

module Util
  def helper(x)
    x
  end
end
