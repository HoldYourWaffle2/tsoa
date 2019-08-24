import * as fs from 'fs'
import * as handlebars from 'handlebars';
import * as path from 'path';
import * as tsfmt from 'typescript-formatter';
import { Tsoa } from '../metadataGeneration/tsoa';
import { assertNever } from '../utils/assertNever';
import { warnAdditionalPropertiesDeprecation } from '../utils/deprecations';
import { fsReadFile, fsWriteFile } from '../utils/fs';
import { RoutesConfig, SwaggerConfig } from './../config';
import { normalisePath } from './../utils/pathUtils';
import { TsoaRoute } from './tsoa-route';

export interface SwaggerConfigRelatedToRoutes {
  noImplicitAdditionalProperties?: SwaggerConfig['noImplicitAdditionalProperties'];
  controllerPathGlobs?: SwaggerConfig['controllerPathGlobs'];
  specVersion?: SwaggerConfig['specVersion'];
}

export class RouteGenerator {
  private tsfmtConfig = {
    editorconfig: true,
    replace: true,
    tsconfig: {
      newLine: 'LF',
    },
    tsfmt: true,
    tslint: false,
    verify: true,
    vscode: true,
  };

  constructor(private readonly metadata: Tsoa.Metadata, private readonly options: RoutesConfig, private readonly minimalSwaggerConfig: SwaggerConfigRelatedToRoutes) {}

  public async GenerateRoutes(middlewareTemplate: string, pathTransformer: (path: string) => string) {
    if (!fs.lstatSync(this.options.routesDir).isDirectory()) {
      throw new Error(`routesDir should be a directory`);
    } else if (this.options.routesFileName !== undefined && !this.options.routesFileName.endsWith('.ts')) {
      throw new Error(`routesFileName should have a '.ts' extension`);
    }

    const fileName = `${this.options.routesDir}/${this.options.routesFileName || 'routes.ts'}`;
    const content = this.buildContent(middlewareTemplate, pathTransformer);

    const formatted = await tsfmt.processString(fileName, content, this.tsfmtConfig as any);
    await fsWriteFile(fileName, formatted.dest);
  }

  public async GenerateCustomRoutes(template: string, pathTransformer: (path: string) => string) {
    const data = await fsReadFile(path.join(template));
    const file = data.toString();
    return await this.GenerateRoutes(file, pathTransformer);
  }

  private buildContent(middlewareTemplate: string, pathTransformer: (path: string) => string) {
    handlebars.registerHelper('json', (context: any) => {
      return JSON.stringify(context);
    });
    const additionalPropsHelper = (additionalProperties: TsoaRoute.ModelSchema['additionalProperties']) => {
      if (additionalProperties) {
        // Then the model for this type explicitly allows additional properties and thus we should assign that
        return JSON.stringify(additionalProperties);
      } else if (this.minimalSwaggerConfig.noImplicitAdditionalProperties === 'silently-remove-extras') {
        return JSON.stringify(false);
      } else if (this.minimalSwaggerConfig.noImplicitAdditionalProperties === 'throw-on-extras') {
        return JSON.stringify(false);
      } else if (this.minimalSwaggerConfig.noImplicitAdditionalProperties === undefined) {
        // Since Swagger defaults to allowing additional properties, then that will be our default
        return JSON.stringify(true);
      } else if (this.minimalSwaggerConfig.noImplicitAdditionalProperties === true) {
        warnAdditionalPropertiesDeprecation(this.minimalSwaggerConfig.noImplicitAdditionalProperties);
        return JSON.stringify(false);
      } else if (this.minimalSwaggerConfig.noImplicitAdditionalProperties === false) {
        warnAdditionalPropertiesDeprecation(this.minimalSwaggerConfig.noImplicitAdditionalProperties);
        return JSON.stringify(true);
      } else {
        return assertNever(this.minimalSwaggerConfig.noImplicitAdditionalProperties);
      }
    };
    handlebars.registerHelper('additionalPropsHelper', additionalPropsHelper);

    handlebars.registerHelper('typeRef', (context: Tsoa.Type) => {
      function getTypeName(type: Tsoa.Type): string {
        /*
          XXX these dataType-based determinations are not 100% safe due to the inheritance-based type structue
          Perhaps it's more appropriate to use a discriminator-based union
        */

        if (type.dataType === 'enum' || type.dataType === 'object') { // there's no ref information for these
          throw new TypeError(`Can't construct type reference for '${type.dataType}'`);
        } else if (type.dataType === 'array') {
          return `${getTypeName((type as Tsoa.ArrayType).elementType)}[]`;
        } else if (type.dataType === 'refObject' || type.dataType === 'refEnum') {
          return (type as Tsoa.ReferenceType).refName;
        } else {
          /*
            XXX it's not possible to do this safely unless we use a very long or-conditional
            Perhaps a separate 'primitive' dataType would be appropriate?
          */

          return type.dataType; // probably a primitive, the name will be enough
        }
      }

      return getTypeName(context);
    });

    handlebars.registerHelper('importController', (controller: any) => { // FIXME liberal any usage, should be the same type as at line 101-126
      const imports: { [file: string]: string[] } = {};

      function addType(type: Tsoa.Type) { // CHECK correct type? parallel typings somewhere?
        if (type.dataType === 'array') { // FUTURE tuple handling?
          addType((type as Tsoa.ArrayType).elementType);
        } else if ('origin' in type) {
          let key;
          if ('refName' in type) {
            key = 'refName';
          } else if ('ref' in type) { // XXX where did this come from again?
            key = 'ref';
          } else {
            throw new TypeError(`Could not find reference for ${type.dataType}`);
          }

          const file = (type as Tsoa.ReferenceType).origin!;
          const typeName = (type as Tsoa.ReferenceType)[key];

          if (!imports[file]) {
            imports[file] = [];
          }

          if (imports[file].indexOf(typeName) < 0) {
            imports[file].push(typeName);
          }
        }
      }

      for (const action of controller.actions) {
        addType(action.type);

        Object.keys(action.parameters).forEach(parameterName => {
          addType(action.parameters[parameterName]);
        });
      }

      return Object.keys(imports).map(file => {
        const types = imports[file].map(n => { // all types imported from this file (only the leftmost identifier)
          const dotIndex = n.indexOf('.');
          return n.substring(0, dotIndex >= 0 ? dotIndex : undefined);
        });

        return `import { ${types.join(', ')} } from '${this.getRelativeImportPath(file)}'`;
      }).join('\n');
    });

    const routesTemplate = handlebars.compile(middlewareTemplate, { noEscape: true });
    const authenticationModule = this.options.authenticationModule ? this.getRelativeImportPath(this.options.authenticationModule) : undefined;
    const iocModule = this.options.iocModule ? this.getRelativeImportPath(this.options.iocModule) : undefined;

    // If we're working locally then tsoa won't exist as an importable module.
    // So, when in testing mode we reference the module by path instead.
    const env = process.env.NODE_ENV;
    let canImportByAlias = true;
    if (env === 'tsoa_test') {
      canImportByAlias = false;
    }

    const normalisedBasePath = normalisePath(this.options.basePath as string, '/');

    return routesTemplate({
      authenticationModule,
      basePath: normalisedBasePath,
      canImportByAlias,
      controllers: this.metadata.controllers.map(controller => {
        const normalisedControllerPath = normalisePath(controller.path, '/');

        return {
          actions: controller.methods.map(method => {
            const parameterObjs: { [name: string]: TsoaRoute.ParameterSchema } = {};
            method.parameters.forEach(parameter => {
              parameterObjs[parameter.parameterName] = this.buildParameterSchema(parameter);
            });
            const normalisedMethodPath = pathTransformer(normalisePath(method.path, '/'));

            const normalisedFullPath = normalisePath(`${normalisedBasePath}${normalisedControllerPath}${normalisedMethodPath}`, '/', '', false);

            return {
              fullPath: normalisedFullPath,
              method: method.method.toLowerCase(),
              name: method.name,
              parameters: parameterObjs,
              path: normalisedMethodPath,
              security: method.security,
              type: method.type,
            };
          }),
          modulePath: this.getRelativeImportPath(controller.location),
          name: controller.name,
          path: normalisedControllerPath,
        };
      }),
      environment: process.env,
      iocModule,
      minimalSwaggerConfig: this.minimalSwaggerConfig,
      models: this.buildModels(),
      useSecurity: this.metadata.controllers.some(controller => controller.methods.some(method => !!method.security.length)),
    });
  }

  public buildModels(): TsoaRoute.Models {
    const models = {} as TsoaRoute.Models;

    Object.keys(this.metadata.referenceTypeMap).forEach(name => {
      const referenceType = this.metadata.referenceTypeMap[name];

      const properties: { [name: string]: TsoaRoute.PropertySchema } = {};
      if (referenceType.properties) {
        referenceType.properties.map(property => {
          properties[property.name] = this.buildPropertySchema(property);
        });
      }

      models[name] = {
        enums: referenceType.enums,
        origin: referenceType.origin,
        properties: Object.keys(properties).length === 0 ? undefined : properties,
      };

      if (referenceType.additionalProperties) {
        models[name].additionalProperties = this.buildProperty(referenceType.additionalProperties);
      } else if (this.minimalSwaggerConfig.noImplicitAdditionalProperties) {
        models[name].additionalProperties = false;
      } else {
        // Since Swagger allows "excess properties" (to use a TypeScript term) by default
        models[name].additionalProperties = true;
      }
    });
    return models;
  }

  private getRelativeImportPath(fileLocation: string) {
    fileLocation = fileLocation.replace('.ts', ''); // no ts extension in import
    return `./${path.relative(this.options.routesDir, fileLocation).replace(/\\/g, '/')}`;
  }

  private buildPropertySchema(source: Tsoa.Property): TsoaRoute.PropertySchema {
    const propertySchema = this.buildProperty(source.type);
    propertySchema.default = source.default;
    propertySchema.required = source.required ? true : undefined;

    if (Object.keys(source.validators).length > 0) {
      propertySchema.validators = source.validators;
    }
    return propertySchema;
  }

  private buildParameterSchema(source: Tsoa.Parameter): TsoaRoute.ParameterSchema {
    const property = this.buildProperty(source.type);
    const parameter = {
      default: source.default,
      in: source.in,
      name: source.name,
      required: source.required ? true : undefined,
    };
    const parameterSchema = Object.assign(parameter, property);

    if (Object.keys(source.validators).length > 0) {
      parameterSchema.validators = source.validators;
    }

    return parameterSchema;
  }

  private buildProperty(type: Tsoa.Type): TsoaRoute.PropertySchema {
    const schema: TsoaRoute.PropertySchema = {
      dataType: type.dataType,
    };

    if ('refName' in type as any) {
      schema.dataType = undefined;
      schema.ref = (type as Tsoa.ReferenceType).refName;
      schema.origin = type.origin;
    }

    if (type.dataType === 'array') {
      const arrayType = type as Tsoa.ArrayType;

      if ('refName' in arrayType.elementType as any) {
        schema.array = {
          origin: arrayType.elementType.origin,
          ref: (arrayType.elementType as Tsoa.ReferenceType).refName,
        };
      } else {
        schema.array = {
          dataType: arrayType.elementType.dataType as any, // FIXME type mismatch
          enums: (arrayType.elementType as Tsoa.EnumerateType).enums,
        };
      }
    }

    if (type.dataType === 'enum') {
      schema.enums = (type as Tsoa.EnumerateType).enums;
    }

    if (type.dataType === 'union' || type.dataType === 'intersection') {
      schema.subSchemas = (type as Tsoa.IntersectionType | Tsoa.UnionType).types.map(type => this.buildProperty(type));
    }

    return schema;
  }
}
