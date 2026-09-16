export const swift = `
(class_declaration "struct" name: (type_identifier) @name) @definition.struct
(class_declaration name: (type_identifier) @name) @definition.class
(protocol_declaration name: (type_identifier) @name) @definition.interface
(function_declaration name: (simple_identifier) @name) @definition.function
(class_body (function_declaration name: (simple_identifier) @name) @definition.method)
(call_expression (simple_identifier) @name) @reference.call
(call_expression (navigation_expression (navigation_suffix (simple_identifier) @name))) @reference.call
`;
