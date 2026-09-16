export const zig = `
(variable_declaration (identifier) @name (struct_declaration)) @definition.struct
(struct_declaration (function_declaration name: (identifier) @name) @definition.method)
(source_file (function_declaration name: (identifier) @name) @definition.function)
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (field_expression member: (identifier) @name)) @reference.call
`;
