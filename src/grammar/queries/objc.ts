export const objc = `
(class_implementation . (identifier) @name) @definition.class
(protocol_declaration . (identifier) @name) @definition.interface
(protocol_declaration (method_declaration (method_type) . (identifier) @name) @definition.method)
(method_definition (method_type) . (identifier) @name) @definition.method
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition.function
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @definition.function
(struct_specifier name: (type_identifier) @name body: (_)) @definition.struct
(enum_specifier name: (type_identifier) @name body: (_)) @definition.enum
(type_definition declarator: (type_identifier) @name) @definition.type
(message_expression receiver: (_) . method: (identifier) @name) @reference.call
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (field_expression field: (field_identifier) @name)) @reference.call
`;
