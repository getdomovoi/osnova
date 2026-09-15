module Greeter = struct
  let format name = String.uppercase_ascii name
  let greet name = format name
end
let run () = Greeter.greet "x"
