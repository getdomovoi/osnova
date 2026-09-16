export const dart = `
(class_definition name: (identifier) @name) @definition.class
(enum_declaration name: (identifier) @name) @definition.enum
(function_signature name: (identifier) @name) @definition.function
(class_body (method_signature (function_signature name: (identifier) @name)) @definition.method)
`;
