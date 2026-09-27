export const dart = `
(class_definition name: (identifier) @name) @definition.class
(enum_declaration name: (identifier) @name) @definition.enum
(function_signature name: (identifier) @name) @definition.function
((function_signature name: (identifier) @name) @definition.function . (function_body) @definition.body)
(class_body (method_signature (function_signature name: (identifier) @name)) @definition.method)
(class_body (method_signature (function_signature name: (identifier) @name)) @definition.method . (function_body) @definition.body)
((identifier) @name @reference.call . (selector (argument_part)))
((selector (unconditional_assignable_selector (identifier) @name)) @reference.call . (selector (argument_part)))
((selector (conditional_assignable_selector (identifier) @name)) @reference.call . (selector (argument_part)))
(new_expression (type_identifier) @name) @reference.call
`;
