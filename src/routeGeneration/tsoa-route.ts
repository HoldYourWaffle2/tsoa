import { Tsoa } from './../metadataGeneration/tsoa';

export namespace TsoaRoute {
    export interface Models {
        [name: string]: ModelSchema;
    }

    export interface ModelSchema {
        enums?: string[];
        properties?: { [name: string]: PropertySchema };
        additionalProperties?: PropertySchema;
        origin?: string;
    }

    export type ValidatorSchema = Tsoa.Validators;

    export interface PropertySchema {
        dataType?: 'string' | 'boolean' | 'double' | 'float' | 'integer' | 'long' | 'enum' | 'array' | 'tuple' | 'datetime' | 'date' | 'buffer' | 'void' | 'any' | 'object'; // FIXME duplicate union (Tsoa.Type.dataType)
        ref?: string;
        origin?: string;
        required?: boolean;
        array?: PropertySchema;
        // FIXME how to implement tuple schema's?
        enums?: string[];
        validators?: ValidatorSchema;
        default?: any;
    }

    export interface ParameterSchema extends PropertySchema {
        name: string;
        in: string;
    }

    export interface Security {
      [key: string]: string[];
    }
}
