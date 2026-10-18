// Project rules that oxlint has no native equivalent for, loaded through its ESLint-compatible JS plugin API (see .oxlintrc.json).

const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*$/;

/**
 * Reports a node whose identifier is not PascalCase.
 * @param {object} context - The rule context
 * @param {object} node - The node to report
 * @param {object | undefined} id - The identifier naming the node
 * @param {string} kind - What the identifier names, for the message
 * @returns {void}
 */
function checkPascalCase(context, node, id, kind) {
	const name = id?.name ?? id?.value;
	if (typeof name === 'string' && !PASCAL_CASE.test(name)) context.report({ node, message: `${kind} \`${name}\` must be PascalCase.` });
}

/**
 * Checks whether a JSDoc block (`/** … *\/`) ends on the line just before a node, or on the same line.
 * @param {object} sourceCode - The source code of the file
 * @param {object} node - The node that must be documented
 * @returns {boolean} `true` when the node has a JSDoc comment
 */
function hasJsDoc(sourceCode, node) {
	const comment = sourceCode.getCommentsBefore(node).at(-1);
	return comment !== undefined && comment.type === 'Block' && comment.value.startsWith('*') && comment.loc.end.line >= node.loc.start.line - 1;
}

/**
 * Finds the statement that carries a function's JSDoc: the `export` declaration wrapping it, or the first of its overload signatures.
 * @param {object} node - A function declaration
 * @returns {object} The statement the JSDoc comment must precede
 */
function firstSignature(node) {
	/**
	 * @param {object} statement - A statement of the enclosing block
	 * @returns {object | undefined} The function it declares, unwrapping `export`
	 */
	function declared(statement) {
		return statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' ? statement.declaration : statement;
	}

	const exported = node.parent?.type === 'ExportNamedDeclaration' || node.parent?.type === 'ExportDefaultDeclaration';
	const statement = exported ? node.parent : node;
	const siblings = statement.parent?.body;
	if (!Array.isArray(siblings) || node.id == null) return statement;

	let index = siblings.indexOf(statement);
	while (index > 0) {
		const previous = declared(siblings[index - 1]);
		if (previous?.type !== 'TSDeclareFunction' || previous.id?.name !== node.id.name) break;
		index--;
	}
	return siblings[index];
}

export default {
	meta: { name: 'tinkit' },
	rules: {
		'no-arrow-functions': {
			meta: { type: 'suggestion', docs: { description: 'Disallow arrow functions in favour of function declarations and expressions.' } },
			create(context) {
				return {
					ArrowFunctionExpression(node) {
						context.report({ node, message: 'Use function declarations/expressions instead of arrow functions.' });
					}
				};
			}
		},
		'require-jsdoc': {
			meta: { type: 'suggestion', docs: { description: 'Require a JSDoc comment on every function declaration.' } },
			create(context) {
				return {
					FunctionDeclaration(node) {
						if (!hasJsDoc(context.sourceCode, firstSignature(node))) context.report({ node, message: 'Missing JSDoc comment.' });
					}
				};
			}
		},
		'pascal-case-types': {
			meta: { type: 'suggestion', docs: { description: 'Require PascalCase names for interfaces, type aliases, type parameters and enum members.' } },
			create(context) {
				return {
					TSInterfaceDeclaration(node) {
						checkPascalCase(context, node, node.id, 'Interface');
					},
					TSTypeAliasDeclaration(node) {
						checkPascalCase(context, node, node.id, 'Type alias');
					},
					TSTypeParameter(node) {
						checkPascalCase(context, node, node.name, 'Type parameter');
					},
					TSEnumMember(node) {
						checkPascalCase(context, node, node.id, 'Enum member');
					}
				};
			}
		}
	}
};
