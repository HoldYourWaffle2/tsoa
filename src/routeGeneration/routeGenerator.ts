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

  constructor(private readonly metadata: Tsoa.Metadata, private readonly options: RoutesConfig, private readonly minimalSwaggerConfig: SwaggerConfigRelatedToRoutes) { }

  public async GenerateRoutes(middlewareTemplate: string, pathTransformer: (path: string) => string) {
    const fileName = `${this.options.routesDir}/routes.ts`;
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
    handlebars.registerHelper('json', (context: any) => JSON.stringify(context));

    handlebars.registerHelper('additionalPropsHelper', (additionalProperties: TsoaRoute.ModelSchema['additionalProperties']) => {
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
    });

    // CHECK what is the context here?
    // XXX do you ever want the non-flattened data in templates?
    handlebars.registerHelper('flattenAggregates', (unflattened: { [name: string]: TsoaRoute.ParameterSchema }) => { // XXX what does 'name' mean here? parameter name? (probably based on the error)
      const flattened: { [name: string]: TsoaRoute.ParameterSchema } = {};

      Object.entries(unflattened).forEach(([name, schema]) => {
        if (flattened[name]) {
          // XXX what does this implicate? can't have objects with the same property names? qualifiers?
          // (I think it means that we can't have a parameter 'x' combined with an object with property 'x')
          throw new ReferenceError(`Duplicate parameter name '${name}'`);
        }

        if (this.isAggregateParameterSchema(schema)) {
          schema.subParameters.forEach(subSchema => flattened[subSchema.name] = subSchema); // XXX shouldn't there be a duplicate check here too?
        } else {
          flattened[name] = schema;
        }
      });

      return flattened;
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

            const normalisedFullPath = normalisePath(
              `${normalisedBasePath}${normalisedControllerPath}${normalisedMethodPath}`, '/', '', false,
            );

            return {
              fullPath: normalisedFullPath,
              method: method.method.toLowerCase(),
              name: method.name,
              parameters: parameterObjs,
              path: normalisedMethodPath,
              security: method.security,
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
      useSecurity: this.metadata.controllers.some(
        controller => controller.methods.some(method => !!method.security.length),
      ),
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
      const modelSchema = {
        enums: referenceType.enums,
        properties: Object.keys(properties).length === 0 ? undefined : properties,
      } as TsoaRoute.ModelSchema;
      if (referenceType.additionalProperties) {
        modelSchema.additionalProperties = this.buildProperty(referenceType.additionalProperties);
      } else if (this.minimalSwaggerConfig.noImplicitAdditionalProperties) {
        modelSchema.additionalProperties = false;
      } else {
        // Since Swagger allows "excess properties" (to use a TypeScript term) by default
        modelSchema.additionalProperties = true;
      }
      models[name] = modelSchema;
    });
    return models;
  }

  private getRelativeImportPath(fileLocation: string) {
    fileLocation = fileLocation.replace('.ts', '');
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

  private buildParameterSchema(source: Tsoa.Parameter): TsoaRoute.ParameterSchema | TsoaRoute.AggregateParameterSchema {
    const schema: TsoaRoute.ParameterSchema = {
      ...this.buildProperty(source.type),
      default: source.default,
      in: source.in,
      name: source.name,
      required: source.required ? true : undefined,
    };

    if (this.isAggregateParameter(source)) { // add sub parameters if we're dealing with an aggregate
      (schema as TsoaRoute.AggregateParameterSchema).subParameters = source.subParameters.map(this.buildParameterSchema.bind(this)); // CHECK this bind necessary?
    }

    if (Object.keys(source.validators).length > 0) { // XXX why the keyset length check?
      schema.validators = source.validators;
    }

    return schema;
  }

  private buildProperty(type: Tsoa.Type): TsoaRoute.PropertySchema { // XXX the type system makes no sense here (PropertySchema for Type?!)
    const schema: TsoaRoute.PropertySchema = {
      dataType: type.dataType,
    };

    const referenceType = type as Tsoa.ReferenceType;
    if (referenceType.refName) {
      schema.dataType = undefined;
      schema.ref = referenceType.refName;
    }

    if (type.dataType === 'array') {
      const arrayType = type as Tsoa.ArrayType;

      const arrayRefType = arrayType.elementType as Tsoa.ReferenceType;
      if (arrayRefType.refName) {
        schema.array = {
          ref: arrayRefType.refName,
        };
      } else {
        schema.array = {
          dataType: arrayType.elementType.dataType,
          enums: (arrayType.elementType as Tsoa.EnumerateType).enums,
        } as TsoaRoute.PropertySchema;
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

  // XXX this feels redundant, can it be generified? (initial effort combining a union with conditional types did not work)

  private isAggregateParameter(parameter: Tsoa.Parameter): parameter is Tsoa.AggregateParameter {
    return (parameter as Tsoa.AggregateParameter).subParameters !== undefined;
  }

  private isAggregateParameterSchema(parameter: TsoaRoute.ParameterSchema): parameter is TsoaRoute.AggregateParameterSchema {
    return (parameter as TsoaRoute.AggregateParameterSchema).subParameters !== undefined;
  }
}
