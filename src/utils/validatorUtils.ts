import * as moment from 'moment';
import * as ts from 'typescript';
import { GenerateMetadataError } from './../metadataGeneration/exceptions';
import { Tsoa } from './../metadataGeneration/tsoa';
import { getJSDocTags } from './jsDocUtils';

export function getParameterValidators(parameter: ts.ParameterDeclaration, parameterName): Tsoa.Validators {
  if (!parameter.parent) {
    return {};
  }

  const tags = getJSDocTags(parameter.parent, tag =>
    supportedParameterTags.some(value => {
      if (!tag.comment) {
        return false;
      }
      return value === tag.tagName.text && tag.comment.startsWith(parameterName);
    }),
  );

  return tags.reduce(
    (validateObj, tag) => {
      if (!tag.comment) {
        return validateObj;
      }
      const comment = tag.comment.substr(tag.comment.indexOf(' ') + 1).trim();

      const name = tag.tagName.text;
      const validator = getValidator(name, comment, getValue(comment));
      /*
                XXX we could probably get away with validateObj[name] = validator!, since not-assigning is the same as assigning undefined
                However, knowing how weird JS can be I have a feeling that this assumption is wrong
            */
      if (validator) {
        validateObj[name] = validator;
      }
      return validateObj;
    },
    {} as Tsoa.Validators,
  );
}

export function getPropertyValidators(property: ts.PropertyDeclaration | ts.PropertySignature): Tsoa.Validators {
  const tags = getJSDocTags(property, tag => supportedParameterTags.some(value => value === tag.tagName.text));

  return tags.reduce(
    (validateObj, tag) => {
      const name = tag.tagName.text;
      const validator = getValidator(name, tag.comment, getValue(tag.comment));
      if (validator) {
        validateObj[name] = validator;
      }
      return validateObj;
    },
    {} as Tsoa.Validators,
  );
}

function getValidator(name: string, comment: string | undefined, value: string | undefined): Tsoa.Validator | undefined {
  switch (name) {
    case 'uniqueItems':
      return {
        errorMsg: getErrorMsg(comment, false),
        value: undefined,
      };
    case 'minimum':
    case 'maximum':
    case 'minItems':
    case 'maxItems':
    case 'minLength':
    case 'maxLength':
      if (isNaN(value as any)) {
        throw new GenerateMetadataError(`${name} parameter use number.`);
      }

      return {
        errorMsg: getErrorMsg(comment),
        value: Number(value),
      };
    case 'minDate':
    case 'maxDate':
      if (!moment(value, moment.ISO_8601, true).isValid()) {
        throw new GenerateMetadataError(`${name} parameter use date format ISO 8601 ex. 2017-05-14, 2017-05-14T05:18Z`);
      }

      return {
        errorMsg: getErrorMsg(comment),
        value,
      };
    case 'pattern':
      if (typeof value !== 'string') {
        throw new GenerateMetadataError(`${name} patameter use string.`);
      }

      return {
        errorMsg: getErrorMsg(comment),
        value,
      };
    default:
      if (name.startsWith('is')) {
        const errorMsg = getErrorMsg(comment, false);
        if (errorMsg) {
          return {
            errorMsg,
            value: undefined,
          };
        }
      }
      return;
  }
}

const supportedParameterTags = [
  'isString',
  'isBoolean',
  'isInt',
  'isLong',
  'isFloat',
  'isDouble',
  'isDate',
  'isDateTime',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'minDate',
  'maxDate',
];

function getValue(comment?: string) {
  if (!comment) {
    return;
  }
  return comment.split(' ')[0];
}

function getErrorMsg(comment?: string, isValue = true) {
  if (!comment) {
    return;
  }

  if (isValue) {
    const indexOf = comment.indexOf(' ');
    return indexOf > 0 ? comment.substr(indexOf + 1) : undefined;
  } else {
    return comment;
  }
}
