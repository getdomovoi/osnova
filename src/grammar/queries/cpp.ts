export const cpp = `
(namespace_definition name: (namespace_identifier) @name) @definition.module
(class_specifier name: (type_identifier) @name body: (_)) @definition.class
(struct_specifier name: (type_identifier) @name body: (_)) @definition.struct
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition.function
(function_definition declarator: (function_declarator declarator: (field_identifier) @name)) @definition.method
(function_definition declarator: (function_declarator declarator: (qualified_identifier name: (identifier) @name))) @definition.function
(enum_specifier name: (type_identifier) @name body: (_)) @definition.enum
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (field_expression field: (field_identifier) @name)) @reference.call
(call_expression function: (qualified_identifier name: (identifier) @name)) @reference.call
`;
