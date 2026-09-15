export const ocaml = `
(module_definition (module_binding (module_name) @name)) @definition.module
(value_definition (let_binding pattern: (value_name) @name (parameter))) @definition.function
(value_definition (let_binding pattern: (value_name) @name body: (fun_expression))) @definition.function
(value_definition (let_binding pattern: (value_name) @name body: (function_expression))) @definition.function
(value_definition (let_binding pattern: (value_name) @name . "=" body: (_) @body (#not-match? @body "^(fun|function)\\\\b"))) @definition.constant
(application_expression function: (value_path (value_name) @name)) @reference.call
`;
