import * as indexOf from 'lodash.indexof';
import * as map from 'lodash.map';
import * as ts from 'typescript';
import { assertNever } from '../utils/assertNever';
import { getJSDocComment, getJSDocTagNames, isExistJSDocTag } from './../utils/jsDocUtils';
import { getPropertyValidators } from './../utils/validatorUtils';
import { GenerateMetadataError } from './exceptions';
import { getInitializerValue } from './initializer-value';
import { MetadataGenerator } from './metadataGenerator';
import { Tsoa } from './tsoa';

const syntaxKindMap: { [kind: number]: string } = {};
syntaxKindMap[ts.SyntaxKind.NumberKeyword] = 'number';
syntaxKindMap[ts.SyntaxKind.StringKeyword] = 'string';
syntaxKindMap[ts.SyntaxKind.BooleanKeyword] = 'boolean';
syntaxKindMap[ts.SyntaxKind.VoidKeyword] = 'void';

const localReferenceTypeCache: { [typeName: string]: Tsoa.ReferenceType } = {}; // XXX why is it called 'localReferenceTypeCache'? Aren't type resolutions done globally (causing the duplicate model name issue)?
const inProgressTypes: string[] = [];

type UsableDeclaration = ts.InterfaceDeclaration | ts.ClassDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration;

export class TypeResolver {
  constructor(private readonly typeNode: ts.TypeNode, private readonly current: MetadataGenerator, private readonly parentNode?: ts.Node, private readonly extractEnum = true) { }

  public static clearCache() {
    Object.keys(localReferenceTypeCache).forEach(key => delete localReferenceTypeCache[key]);
    inProgressTypes.splice(0);
  }

  public resolve(): Tsoa.Type | Tsoa.ArrayType | Tsoa.EnumerateType | Tsoa.UnionType | Tsoa.IntersectionType {
    const primitiveType = this.getPrimitiveType(this.typeNode, this.parentNode);
    if (primitiveType) {
      return primitiveType;
    }

    if (ts.isArrayTypeNode(this.typeNode)) {
      return {
        dataType: 'array',
        elementType: new TypeResolver(this.typeNode.elementType, this.current).resolve(),
      };
    }

    if (ts.isUnionTypeNode(this.typeNode)) {
      const supportType = this.typeNode.types.every(type => ts.isLiteralTypeNode(type));

      if (supportType) {
        return {
          dataType: 'enum',
          enums: (this.typeNode.types as ts.NodeArray<ts.LiteralTypeNode>).map(type => {
            switch (type.literal.kind) {
              case ts.SyntaxKind.TrueKeyword:
                return 'true';
              case ts.SyntaxKind.FalseKeyword:
                return 'false';
              default:
                return (type.literal as ts.LiteralExpression).text; // XXX what about ts.PrefixUnaryExpression?
            }
          }),
        };
      } else {
        const types = this.typeNode.types.map(type => {
          return new TypeResolver(type, this.current, this.parentNode, this.extractEnum).resolve();
        });

        return {
          dataType: 'union',
          types,
        };
      }
    }

    if (ts.isIntersectionTypeNode(this.typeNode)) {
      const types = this.typeNode.types.map(type => {
        return new TypeResolver(type, this.current, this.parentNode, this.extractEnum).resolve();
      });

      return {
        dataType: 'intersection',
        types,
      };
    }

    if (this.typeNode.kind === ts.SyntaxKind.AnyKeyword) {
      return { dataType: 'any' };
    }

    if (ts.isTypeLiteralNode(this.typeNode)) {
      return { dataType: 'any' }; // XXX type literal => any?
    }

    if (this.typeNode.kind === ts.SyntaxKind.ObjectKeyword) {
      return { dataType: 'object' };
    }

    if (!ts.isTypeReferenceNode(this.typeNode)) {
      throw new GenerateMetadataError(`Unknown syntax kind: ${ts.SyntaxKind[this.typeNode.kind]}`);
    }

    const typeReference = this.typeNode;

    if (ts.isIdentifier(typeReference.typeName)) {
      if (typeReference.typeName.text === 'Date') {
        return this.getDateType(this.parentNode);
      }

      if (typeReference.typeName.text === 'Buffer') {
        return { dataType: 'buffer' };
      }

      if (typeReference.typeName.text === 'Array' && typeReference.typeArguments && typeReference.typeArguments.length === 1) {
        return {
          dataType: 'array',
          elementType: new TypeResolver(typeReference.typeArguments[0], this.current).resolve(),
        };
      }

      if (typeReference.typeName.text === 'Promise' && typeReference.typeArguments && typeReference.typeArguments.length === 1) {
        return new TypeResolver(typeReference.typeArguments[0], this.current).resolve();
      }

      if (typeReference.typeName.text === 'String') {
        return { dataType: 'string' };
      }
    }

    if (!this.extractEnum) {
      const enumType = this.getEnumerateType(typeReference.typeName, this.extractEnum);
      if (enumType) {
        return enumType;
      }
    }

    const literalType = this.getLiteralType(typeReference.typeName);
    if (literalType) {
      return literalType;
    }

    let referenceType: Tsoa.ReferenceType;
    if (typeReference.typeArguments && typeReference.typeArguments.length === 1) {
      // XXX what if we have >1 type argument?
      referenceType = this.getReferenceType(typeReference.typeName, this.extractEnum, typeReference.typeArguments);
    } else {
      referenceType = this.getReferenceType(typeReference.typeName, this.extractEnum);
    }

    this.current.AddReferenceType(referenceType);

    // We do a hard assert in the test mode so we can catch bad ref names (https://github.com/lukeautry/tsoa/issues/398).
    //   The goal is to avoid producing these names before the code is ever merged to master (via extensive test coverage)
    //   and therefore this validation does not have to run for the users
    if (process.env.NODE_ENV === 'tsoa_test') {
      // This regex allows underscore, hyphen, and period since those are valid in SwaggerEditor
      const symbolsRegex = /[!$%^&*()+|~=`{}\[\]:";'<>?,\/]/;
      if (symbolsRegex.test(referenceType.refName)) {
        throw new Error(
          `Problem with creating refName ${referenceType.refName} since we should not allow symbols in ref names ` +
          `because it would cause invalid swagger.yaml to be created. This is due to the swagger rule ` +
          `"ref values must be RFC3986-compliant percent-encoded URIs."`,
        );
      }
    }

    return referenceType;
  }

  private getPrimitiveType(typeNode: ts.TypeNode, parentNode?: ts.Node): Tsoa.Type | undefined {
    const primitiveType = syntaxKindMap[typeNode.kind];
    if (!primitiveType) {
      return;
    }

    if (primitiveType === 'number') {
      if (!parentNode) {
        return { dataType: 'double' };
      }

      const tags = getJSDocTagNames(parentNode).filter(name => {
        return ['isInt', 'isLong', 'isFloat', 'isDouble'].some(m => m === name);
      });
      if (tags.length === 0) {
        return { dataType: 'double' };
      }

      switch (tags[0]) {
        case 'isInt':
          return { dataType: 'integer' };
        case 'isLong':
          return { dataType: 'long' };
        case 'isFloat':
          return { dataType: 'float' };
        case 'isDouble':
          return { dataType: 'double' };
        default:
          return { dataType: 'double' };
      }
    }
    return { dataType: primitiveType } as Tsoa.Type;
  }

  private getDateType(parentNode?: ts.Node): Tsoa.Type {
    if (!parentNode) {
      return { dataType: 'datetime' };
    }
    const tags = getJSDocTagNames(parentNode).filter(name => {
      return ['isDate', 'isDateTime'].some(m => m === name);
    });

    if (tags.length === 0) {
      return { dataType: 'datetime' };
    }
    switch (tags[0]) {
      case 'isDate':
        return { dataType: 'date' };
      case 'isDateTime':
        return { dataType: 'datetime' };
      default:
        return { dataType: 'datetime' };
    }
  }

  private getEnumerateType(typeName: ts.EntityName, extractEnum = true): Tsoa.EnumerateType | Tsoa.ReferenceType | undefined {
    const enumName = this.getEntityNameSimpleText(typeName);
    const enumNodes = this.current.nodes.filter(node => node.kind === ts.SyntaxKind.EnumDeclaration).filter(node => (node as any).name.text === enumName);

    if (!enumNodes.length) {
      return;
    }
    if (enumNodes.length > 1) {
      throw new GenerateMetadataError(`Multiple matching enum found for enum ${enumName}; please make enum names unique.`);
    }

    const enumDeclaration = enumNodes[0];

    function getEnumValue(member: ts.EnumMember) {
      if (member.initializer) {
        if ((member.initializer as any).expression) {
          // This applies to initializations with sub-expressions such as an AsExpression
          return (member.initializer as any).expression.text;
        }
        return member.initializer.getText(); // XXX does this work?
      }
      return;
    }

    const enums = enumDeclaration.members.map((member, index) => getEnumValue(member) || index.toString());
    if (extractEnum) {
      // XXX extracting means keeping the reference?
      return {
        dataType: 'refEnum',
        description: this.getNodeDescription(enumDeclaration),
        enums,
        refName: enumName,
      };
    } else {
      return {
        dataType: 'enum',
        enums,
      };
    }
  }

  private getLiteralType(typeName: ts.EntityName): Tsoa.Type | Tsoa.EnumerateType | undefined {
    const literalName = this.getEntityNameSimpleText(typeName);
    const literalTypes = this.current.nodes
      .filter(ts.isTypeAliasDeclaration)
      .filter(node => ts.isUnionTypeNode(node.type) && node.type.types)
      .filter(node => node.name.text === literalName);

    if (!literalTypes.length) {
      return;
    }
    if (literalTypes.length > 1) {
      throw new GenerateMetadataError(`Multiple matching enum found for enum ${literalName}; please make enum names unique.`);
    }

    const unionTypes = (literalTypes[0].type as ts.UnionTypeNode).types;
    if (!unionTypes.every(ts.isLiteralTypeNode)) { // non-pure literal union
      // tagged union types can't be expressed in Swagger terms, probably (XXX is this true?)
      return { dataType: 'any' };
    }

    return {
      dataType: 'enum', // XXX I assume an enum is used here to represent literal unions in swagger?
      enums: (unionTypes as ts.NodeArray<ts.LiteralTypeNode>).map(unionNode => {
        const text = unionNode.literal.getText(); // assertion is checked by every(ts.isLiteralTypeNode) check above (XXX does getText() work?)
        return text.substring(1, text.length - 1); // need to cutoff the quotation marks
      }),
    };
  }

  private getReferenceType(type: ts.EntityName, extractEnum = true, genericTypes?: ts.NodeArray<ts.TypeNode>): Tsoa.ReferenceType {
    const typeName = this.getEntityNameFullText(type);
    const refNameWithGenerics = this.getTypeName(typeName, genericTypes);

    try {
      const existingType = localReferenceTypeCache[refNameWithGenerics];
      if (existingType) {
        return existingType;
      }

      const referenceEnumType = this.getEnumerateType(type, true) as Tsoa.ReferenceType | undefined; // we know it's a Tsoa.ReferenceType because extractEnum = true
      if (referenceEnumType) {
        localReferenceTypeCache[refNameWithGenerics] = referenceEnumType;
        return referenceEnumType;
      }


      if (inProgressTypes.includes(refNameWithGenerics)) {
        return this.createCircularDependencyResolver(refNameWithGenerics);
      }

      inProgressTypes.push(refNameWithGenerics);

      const modelType = this.getModelTypeDeclaration(type);
      const properties = this.getModelProperties(modelType, genericTypes);
      const additionalProperties = this.getModelAdditionalProperties(modelType);
      const inheritedProperties = this.getModelInheritedProperties(modelType) || [];
      const example = this.getNodeExample(modelType);

      const referenceType: Tsoa.ReferenceType = {
        additionalProperties,
        dataType: 'refObject',
        description: this.getNodeDescription(modelType),
        example,
        properties: inheritedProperties,
        refName: refNameWithGenerics,
      };

      referenceType.properties = referenceType.properties!.concat(properties);
      localReferenceTypeCache[refNameWithGenerics] = referenceType;

      return referenceType;
    } catch (err) {
      // tslint:disable-next-line:no-console
      console.error(`There was a problem resolving type of '${refNameWithGenerics}'.`);
      throw err;
    }
  }

  private getEntityNameSimpleText(node: ts.EntityName): string {
    return ts.isIdentifier(node) ? node.text : node.right.text;
  }

  private getEntityNameFullText(type: ts.EntityName): string {
    if (ts.isIdentifier(type)) {
      return type.text;
    } else {
      return `${this.getEntityNameFullText(type.left)}.${type.right.text}`;
    }
  }

  private getTypeName(typeName: string, genericTypes?: ts.NodeArray<ts.TypeNode>): string {
    if (!genericTypes || !genericTypes.length) {
      return typeName;
    }

    const resolvedName = genericTypes.reduce(
      (acc, generic) => {
        if (ts.isTypeReferenceNode(generic) && generic.typeArguments && generic.typeArguments.length > 0) {
          const typeNameSection = this.getTypeName(generic.typeName.getText(), generic.typeArguments);
          acc.push(typeNameSection);
          return acc;
        } else {
          const typeNameSection = this.getAnyTypeName(generic);
          acc.push(typeNameSection);
          return acc;
        }
      },
      [] as string[],
    );

    const finalName = typeName + resolvedName.join('');

    return finalName;
  }

  private getAnyTypeName(typeNode: ts.TypeNode): string {
    const primitiveType = syntaxKindMap[typeNode.kind];
    if (primitiveType) {
      return primitiveType;
    }

    if (ts.isArrayTypeNode(node)) {
      return this.getAnyTypeName(node.elementType) + 'Array';
    }

    if (ts.isUnionTypeNode(node)) {
      return 'object';
    }

    if (ts.isTypeReferenceNode(node)) {
      return node.typeName.getText(); // XXX does this work?
    }

    throw new GenerateMetadataError(`Unknown type: ${ts.SyntaxKind[node.kind]}.`);
  }

  private createCircularDependencyResolver(refName: string): Tsoa.ReferenceType {
    const referenceType: Tsoa.ReferenceType = {
      dataType: 'refObject',
      refName,
    };

    // XXX this doesn't look safe at all
    this.current.OnFinish(referenceTypes => {
      const realReferenceType = referenceTypes[refName];
      if (!realReferenceType) {
        return;
      }
      referenceType.description = realReferenceType.description;
      referenceType.properties = realReferenceType.properties;
      referenceType.dataType = realReferenceType.dataType;
      referenceType.refName = referenceType.refName;
    });

    return referenceType;
  }

  private nodeIsUsable(node: ts.Node): node is UsableDeclaration {
    return ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node);
  }

  private resolveLeftmostIdentifier(type: ts.EntityName): ts.Identifier {
    let current = type;
    while (!ts.isIdentifier(current)) {
      current = current.left;
    }
    return current;
  }

  private resolveModelTypeScope(leftmost: ts.EntityName, statements: ts.Node[]): ts.NodeArray<ts.Node> {
    // CHECK correct any narrowing?
    /*
      WHILE (there are more quantifiers)
        Resolve next quantifier using the statements in the 'state'
        Set 'state' to the statements of the newly found block

      This way the referenced node is narrowed down per-quantification
    */

    // This is a ts.Node[] on the first step
    let state: ts.Node[] | ts.NodeArray<ts.Node> = statements;

    while (leftmost.parent && ts.isQualifiedName(leftmost.parent)) {
      const leftmostName = ts.isIdentifier(leftmost) ? leftmost.text : leftmost.right.text;

      const moduleDeclarations = state
        .filter(ts.isModuleDeclaration)
        .filter(this.current.IsExportedNode)
        .filter((node: ts.ModuleDeclaration) => node.name.text.toLowerCase() === leftmostName.toLowerCase()) as ts.ModuleDeclaration[];

      if (!moduleDeclarations.length) {
        throw new GenerateMetadataError(`No matching module declarations found for ${leftmostName}.`);
      }
      if (moduleDeclarations.length > 1) {
        throw new GenerateMetadataError(`Multiple matching module declarations found for ${leftmostName}; please make module declarations unique.`);
        const declaration = moduleDeclarations[0];

        if (declaration.body && ts.isModuleBlock(declaration.body)) {
          state = declaration.body.statements;
          leftmost = leftmost.parent as ts.EntityName; // XXX is this safe?
        } else {
          throw new GenerateMetadataError(`Module declaration found for ${leftmostName} has no body.`);
        }
      }
    }

    return state as ts.NodeArray<ts.Node>;
  }

  private getModelTypeDeclaration(type: ts.EntityName): UsableDeclaration {
    const statements: ts.NodeArray<ts.Node> = this.resolveModelTypeScope(this.resolveLeftmostIdentifier(type), this.current.nodes);
    const typeName = this.getEntityNameSimpleText(type);

    let modelTypes = statements.filter(node => {
      if (!this.nodeIsUsable(node) || !this.current.IsExportedNode(node)) {
        return false;
      }
      return node.name!.text === typeName; // FIXME this non-null assertion is unsafe as stated by the documentation: "May be undefined in export default class { ... }"
    }) as UsableDeclaration[];

    if (modelTypes.length === 0) {
      throw new GenerateMetadataError(
        `No matching model found for referenced type ${typeName}. If ${typeName} comes from a dependency, please create an interface in your own code that has the same structure. Tsoa can not utilize interfaces from external dependencies. Read more at https://github.com/lukeautry/tsoa/blob/master/ExternalInterfacesExplanation.MD`,
      );
    } else if (modelTypes.length === 1) {
      // exactly one match, easy
      return modelTypes[0];
    } else {
      // multiple matching models
      // remove types that are from typescript e.g. 'Account' (XXX this means that non-TS types have priority, this makes sense but is it documented?)
      modelTypes = modelTypes.filter(
        modelType =>
          !modelType
            .getSourceFile()
            .fileName.replace(/\\/g, '/')
            .toLowerCase()
            .includes('node_modules/typescript'), // XXX this breaks if you're using a forked compiler, but I don't think that's an edge case worth solving
      );

      if (modelTypes.length === 0) {
        // FIXME Uncovered edge case: a model with a name that exists twice in the standard library
        throw new GenerateMetadataError(`Multiple standard library models with name ${typeName}`); // obviously not a proper error message
      } else if (modelTypes.length === 1) {
        // there's only one "user-made" match
        return modelTypes[0];
      } else {
        // still multiple models left
        // Models marked with '@tsoaModel', indicating that it should be the 'canonical' model used
        const designatedModels = modelTypes.filter(modelType => isExistJSDocTag(modelType, tag => tag.tagName.text === 'tsoaModel'));

        if (designatedModels.length === 1) {
          // a single marked-canonical model
          return designatedModels[0];
        } else if (designatedModels.length > 1) {
          // multiple marked-canonical models
          throw new GenerateMetadataError(`Multiple models for ${typeName} marked with '@tsoaModel'; '@tsoaModel' should only be applied to one model.`);
        } else {
          // no marked-canonical model
          const conflicts = modelTypes.map(modelType => modelType.getSourceFile().fileName).join('"; "');
          throw new GenerateMetadataError(`Multiple matching models found for referenced type ${typeName}; please make model names unique. Conflicts found: "${conflicts}".`);
        }
      }
    }
  }

  private getModelProperties(node: UsableDeclaration, genericTypes?: ts.NodeArray<ts.TypeNode>): Tsoa.Property[] {
    function isIgnored(e: ts.TypeElement | ts.ClassElement) {
      return isExistJSDocTag(e, tag => tag.tagName.text === 'ignore');
    }

    if (ts.isInterfaceDeclaration(node)) {
      // Interface model
      return node.members
        .filter(member => !isIgnored(member) && ts.isPropertySignature(member))
        .map((propertyDeclaration: ts.PropertySignature) => {
          if (!propertyDeclaration.type) {
            throw new GenerateMetadataError(`No valid type found for property declaration.`);
          }

          // Declare a variable that can be overridden if needed
          let aType = propertyDeclaration.type;

          // aType.kind will always be a TypeReference when the property of Interface<T> is of type T
          if (ts.isTypeReferenceNode(aType) && genericTypes && genericTypes.length && node.typeParameters) {
            // The type definitions are conveniently located on the object which allow us to map -> to the genericTypes
            const typeParams = map(node.typeParameters, typeParam => typeParam.name.text);

            // I am not sure in what cases
            const typeIdentifier = aType.typeName;
            // typeIdentifier can either be a Identifier or a QualifiedName
            const typeIdentifierName = this.getEntityNameSimpleText(typeIdentifier);

            // I could not produce a situation where this did not find it so its possible this check is irrelevant
            const indexOfType = indexOf(typeParams, typeIdentifierName);
            if (indexOfType >= 0) {
              aType = genericTypes[indexOfType];
            }
          }

          return {
            default: getJSDocComment(propertyDeclaration, 'default'),
            description: this.getNodeDescription(propertyDeclaration),
            format: this.getNodeFormat(propertyDeclaration),
            name: propertyDeclaration.name.getText(), // CHECK does this work? Do computed property names work?
            required: !propertyDeclaration.questionToken,
            type: new TypeResolver(aType, this.current, aType.parent).resolve(),
            validators: getPropertyValidators(propertyDeclaration),
          };
        });
    } else if (ts.isTypeAliasDeclaration(node)) {
      // Type alias model
      const properties: Tsoa.Property[] = [];

      if (node.type.kind === ts.SyntaxKind.IntersectionType) {
        const intersectionTypeNode = node.type as ts.IntersectionTypeNode;

        intersectionTypeNode.types.forEach(type => {
          if (type.kind === ts.SyntaxKind.TypeReference) {
            const typeReferenceNode = type as ts.TypeReferenceNode;
            const modelType = this.getModelTypeDeclaration(typeReferenceNode.typeName);
            const modelProps = this.getModelProperties(modelType);
            properties.push(...modelProps);
          }
        });
      }

      if (ts.isTypeReferenceNode(node.type)) {
        const modelType = this.getModelTypeDeclaration(node.type.typeName);
        const modelProps = this.getModelProperties(modelType);
        properties.push(...modelProps);
      }
      return properties;
    } else if (ts.isClassDeclaration(node)) {
      // Class model
      const properties = node.members
        .filter(member => !isIgnored(member))
        .filter(member => ts.isPropertyDeclaration(member))
        .filter(member => this.hasPublicModifier(member)) as Array<ts.PropertyDeclaration | ts.ParameterDeclaration>; // ParameterDeclaration because properties can be defined by constructor parameters

      const classConstructor = node.members.find(ts.isConstructorDeclaration) as ts.ConstructorDeclaration | undefined;
      if (classConstructor && classConstructor.parameters) {
        const constructorProperties = classConstructor.parameters.filter(parameter => this.isAccessibleParameter(parameter));

        properties.push(...constructorProperties);
      }

      return properties.map(property => {
        let typeNode = property.type;

        if (!typeNode) {
          const tsType = this.current.typeChecker.getTypeAtLocation(property);
          typeNode = this.current.typeChecker.typeToTypeNode(tsType);
        }

        if (!typeNode) {
          throw new GenerateMetadataError(`No valid type found for property declaration.`);
        }

        const type = new TypeResolver(typeNode, this.current, property).resolve();

        return {
          default: getInitializerValue(property.initializer, type),
          description: this.getNodeDescription(property),
          format: this.getNodeFormat(property),
          name: property.name.getText(), // XXX does this work? Computed property names?
          required: !property.questionToken && !property.initializer,
          type,
          validators: getPropertyValidators(property as ts.PropertyDeclaration),
        };
      });
    } else if (ts.isEnumDeclaration(node)) {
      /*
        FIXME no implementation
        this.isNodeUsable has always returned true for enum declarations
        This method is used in this.getModelTypeDeclaration to assert the UsableDeclaration type
        This means that UsableDeclaration should include ts.EnumDeclaration
      */
      throw new Error('Unimplemented code path');
    } else {
      return assertNever(node);
    }
  }

  private getModelAdditionalPropertiesType(node: UsableDeclaration): Tsoa.Type | undefined {
    if (!ts.isInterfaceDeclaration(node)) {
      return;
    }

    const indexSignatureDeclaration = node.members.find(ts.isIndexSignatureDeclaration);
    if (!indexSignatureDeclaration) {
      return;
    }

    const indexType = new TypeResolver(indexSignatureDeclaration.parameters[0].type!, this.current).resolve(); // parameters of an index signature are never undefined
    if (indexType.dataType !== 'string') {
      throw new GenerateMetadataError(`Only string indexers are supported.`); // XXX why?
    }

    return new TypeResolver(indexSignatureDeclaration.type!, this.current).resolve(); // index signature declarations always have a type
  }

  private getModelInheritedProperties(modelTypeDeclaration: UsableDeclaration): Tsoa.Property[] {
    const properties: Tsoa.Property[] = [];
    if (ts.isTypeAliasDeclaration(modelTypeDeclaration) || ts.isEnumDeclaration(modelTypeDeclaration)) {
      return [];
    }

    const heritageClauses = modelTypeDeclaration.heritageClauses;
    if (!heritageClauses) {
      return properties;
    }

    heritageClauses.forEach(clause => {
      if (!clause.types) {
        return;
      }

      clause.types.forEach(type => {
        /*
          XXX this cast is needed due to (probably) a bug in Typescript.

          The ts.ExpressionWithTypeArguments typings say that 'expression' is a ts.LeftHandSideExpression.
          However, an AST viewer (https://ts-ast-viewer.com/) says that it's in fact a ts.Identifier, which is what we've observed (and used) too
          Weirdly enough, LeftHandSideExpression and Identifier are in no way related.

          I couldn't find a way to make the 'expression' property show up as something other than an Identifier, so this is probably just a mistyping.
        */
        const referenceType = this.getReferenceType(type.expression as ts.Identifier);
        if (referenceType.properties) {
          properties.push(...referenceType.properties);
        }
      });
    });

    return properties;
  }

  private hasPublicModifier(node: ts.Node) {
    return !node.modifiers || node.modifiers.every(modifier => modifier.kind !== ts.SyntaxKind.ProtectedKeyword && modifier.kind !== ts.SyntaxKind.PrivateKeyword);
  }

  private isAccessibleParameter(node: ts.Node) {
    // No modifiers
    if (!node.modifiers) {
      return false;
    }

    // public || public readonly
    if (node.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.PublicKeyword)) {
      return true;
    }

    // readonly, not private readonly, not public readonly
    const isReadonly = node.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ReadonlyKeyword);
    const isProtectedOrPrivate = node.modifiers.some(modifier => {
      return modifier.kind === ts.SyntaxKind.ProtectedKeyword || modifier.kind === ts.SyntaxKind.PrivateKeyword;
    });
    return isReadonly && !isProtectedOrPrivate;
  }

  private getNodeDescription(node: ts.NamedDeclaration) {
    const symbol = this.current.typeChecker.getSymbolAtLocation(node.name!); // XXX is this a safe assertion?
    if (!symbol) {
      return undefined;
    }

    /**
     * TODO: Workaround for what seems like a bug in the compiler
     * Warrants more investigation and possibly a PR against typescript
     */
    if (ts.isParameter(node)) {
      // TypeScript won't parse jsdoc if the flag is 4, i.e. 'Property'
      symbol.flags = 0;
    }

    const comments = symbol.getDocumentationComment(this.current.typeChecker);
    if (comments.length) {
      return ts.displayPartsToString(comments);
    }

    return undefined;
  }

  private getNodeFormat(node: ts.Node) {
    return getJSDocComment(node, 'format');
  }

  private getNodeExample(node: ts.NamedDeclaration) {
    const example = getJSDocComment(node, 'example');

    if (example) {
      return JSON.parse(example);
    } else {
      return undefined;
    }
  }
}
