export const elixir = `
(call target: (identifier) @kw (#eq? @kw "defmodule") (arguments (alias) @name)) @definition.module
(call target: (identifier) @kw (#any-of? @kw "def" "defp" "defmacro") (arguments (call target: (identifier) @name) @definition.head)) @definition.function
(call target: (identifier) @name) @reference.call
(call target: (dot right: (identifier) @name)) @reference.call
`;
