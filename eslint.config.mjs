import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [{
    files: ["**/*.ts"],
}, {
    plugins: {
        "@typescript-eslint": typescriptEslint,
    },

    languageOptions: {
        parser: tsParser,
        ecmaVersion: 2022,
        sourceType: "module",

        parserOptions: {
            project: "./tsconfig.json",
            tsconfigRootDir: import.meta.dirname,
        },
    },

    rules: {
        "@typescript-eslint/naming-convention": ["warn", {
            selector: "import",
            format: ["camelCase", "PascalCase"],
        }],

        curly: "error",
        eqeqeq: "error",
        "no-throw-literal": "error",
        semi: "error",

        // Empty blocks hide real failures; an intentional ignore needs a comment.
        "no-empty": ["error", { allowEmptyCatch: false }],

        "@typescript-eslint/no-unused-vars": ["error", {
            argsIgnorePattern: "^_",
            varsIgnorePattern: "^_",
            caughtErrorsIgnorePattern: "^_",
        }],

        "@typescript-eslint/no-floating-promises": ["error", {
            ignoreVoid: true,
        }],

        // Warn for now; ratchet to error once the remaining `any`s are typed.
        "@typescript-eslint/no-explicit-any": "warn",
    },
}];
