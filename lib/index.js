'use strict';
var _ = require('lodash');
var mongoose = require('mongoose');
var Schema = mongoose.Schema;
var path = require('path');

var allowedTypes = ['number', 'integer', 'long', 'float', 'double', 'string', 'password', 'boolean', 'date', 'dateTime', 'array'];
var definitions = null;
var swaggerVersion = null;
var v2MongooseProperty = 'x-swagger-mongoose';
var v1MongooseProperty = '_mongoose';
var xSwaggerMongoose = {
  schemaOptions: {},
  additionalProperties: {},
  excludeSchema: {},
  documentIndex: {},
  nextedschemas: {}
};
var validators = {};

var propertyMap = function(property) {
  switch (property.type) {
    case 'number':
      switch (property.format) {
        case 'integer':
        case 'long':
        case 'float':
        case 'double':
          return Number;
        default:
          throw new Error('Unrecognised schema format: ' + property.format);
      }
    case 'integer':
    case 'long' :
    case 'float' :
    case 'double' :
      return Number;
    case 'string':
    case 'password':
      switch (property.format) {
        case 'date':
        case 'date-time':
          return Date;
      }
      return String;
    case 'boolean':
      return Boolean;
    case 'array':
      return [propertyMap(property.items)];
    default:
      console.log('Warning Unrecognized schema type of ' + property)
      _.each(property, function(val, key) {
        console.log("pair:", key, val)
      })
      return String;
    //throw new Error('Unrecognized schema type: ' + property.type);
  }
};

var convertToJSON = function(spec) {
  var swaggerJSON = {};
  var type = typeof(spec);
  switch (type) {
    case 'object':
      if (spec instanceof Buffer) {
        swaggerJSON = JSON.parse(spec);
      } else {
        swaggerJSON = spec;
      }
      break;
    case 'string':
      swaggerJSON = JSON.parse(spec);
      break;
    default:
      throw new Error('Unknown or invalid spec object');
      break;
  }
  return swaggerJSON;
};

var isSimpleSchema = function(schema) {
  return schema.type && isAllowedType(schema.type);
};

var isAllowedType = function(type) {
  return allowedTypes.indexOf(type) != -1;
};

var isPropertyHasRef = function(property) {
  return property['$ref'] || ((property['type'] == 'array') && (property['items']['$ref']));
};

var fillRequired = function(object, key, template) {
  if (template && Array.isArray(template) && template.indexOf(key) >= 0) {
    object[key].required = true;
  } else if (typeof template === 'boolean') {
    object[key].required = template;
  }
};

var applyExtraDefinitions = function(definitions, _extraDefinitions) {
  if (_extraDefinitions) {
    
    //TODO: check for string or object assume object for now.
    // var extraDefinitions = JSON.parse(_extraDefinitions);
    var mongooseProperty = getMongooseProperty();
    
    //remove default object from extra, we're going to handle that seperately
    var defaultDefs;
    if (!_extraDefinitions.default) {
      defaultDefs = null;
    } else {
      defaultDefs = _extraDefinitions.default
      delete _extraDefinitions.default;
      _.each(definitions, function(val, key) {
        //lets add that default to everything.
        val[mongooseProperty] = defaultDefs
      });
    }
    
    var extraDefinitions = _extraDefinitions;
    _.each(extraDefinitions, function(val, key) {
      definitions[key][mongooseProperty] = val
    });
    
  }
};

var isAtLeastSwagger2 = function() {
  return swaggerVersion >= 2;
};

var getMongooseProperty = function() {
  return (isAtLeastSwagger2()) ? v2MongooseProperty : v1MongooseProperty;
};

var isMongooseProperty = function(property) {
  return !!property[getMongooseProperty()];
};

var isMongooseArray = function(property) {
  return property.items && property.items[getMongooseProperty()];
};

var getMongooseSpecific = function(props, property) {
  var mongooseProperty = getMongooseProperty();
  var mongooseSpecific = property[mongooseProperty];
  var ref = (isAtLeastSwagger2() && mongooseSpecific) ? mongooseSpecific.$ref : property.$ref;
  
  if (!mongooseSpecific && isMongooseArray(property)) {
    mongooseSpecific = property.items[mongooseProperty];
    ref = (isAtLeastSwagger2()) ? mongooseSpecific.$ref : property.items.$ref;
  }
  
  if (!mongooseSpecific) {
    return props;
  }
  
  var ret = {};
  if (ref) {
    if (!isAtLeastSwagger2()) {
      if (mongooseSpecific.type === 'objectId') {
        ret.type = Schema.Types.ObjectId;
        if (mongooseSpecific.includeSwaggerRef !== false) {
          ret.ref = ref.replace('#/definitions/', '');
        }
      }
    } else {
      ret.type = Schema.Types.ObjectId;
      ret.ref = ref.replace('#/definitions/', '');
    }
  } else if (mongooseSpecific.validator) {
    var validator = validators[mongooseSpecific.validator];
    ret = _.extend(ret, property, {validate: validator});
    delete ret[mongooseProperty];
  } else {
    ret = _.extend(ret, property, mongooseSpecific);
    delete ret[mongooseProperty];
    if (isSimpleSchema(ret)) {
      ret.type = propertyMap(ret);
    }
  }
  
  return ret;
};

var isMongodbReserved = function(fieldKey) {
  return fieldKey === '_id' || fieldKey === '__v';
};

var processRef = function(property, objectName, props, key, required) {
  var refRegExp = /^#\/definitions\/(\w*)$/;
  var refString = property['$ref'] ? property['$ref'] : property['items']['$ref'];
  var propType = refString.match(refRegExp)[1];
  // NOT circular reference
  if (propType !== objectName) {
    var object = definitions[propType];
    if (~['array', 'object'].indexOf(object.type)) {
      if (!xSwaggerMongoose.nextedschemas[propType]) {
        var schema = getSchema(propType, object);
        
        var customMongooseProperty = getMongooseProperty();
        
        var options = xSwaggerMongoose.schemaOptions;
        if (object[customMongooseProperty]) {
          processMongooseDefinition(propType, object[customMongooseProperty]);
        }
        var documentIndex = xSwaggerMongoose.documentIndex;
        options = _.extend({}, options[customMongooseProperty], options[propType]);
        xSwaggerMongoose.nextedschemas[propType] = new mongoose.Schema(schema, options);
        if (typeof documentIndex === 'object') {
          documentIndex = documentIndex[customMongooseProperty] || documentIndex[propType];
        }
        processDocumentIndex(xSwaggerMongoose.nextedschemas[propType], documentIndex);
      }
      var schema_nested = xSwaggerMongoose.nextedschemas[propType];
      props[key] = property['items'] || object.type === 'array' ? {type: [schema_nested]} : {type: schema_nested};
      
    } else {
      var clone = _.extend({}, object);
      delete clone[getMongooseProperty()];
      var schemaProp = getSchemaProperty(clone, key)[key];
      props[key] = property['items'] ? [schemaProp] : schemaProp;
    }
  } else {
    // circular reference
    if (propType) {
      props[key] = {
        type: Schema.Types.ObjectId,
        ref: propType
      };
    }
  }
  //this is all the time done in getSchemaProperty (and getSchema)
  // fillRequired(props, key, required);
};

var getSchema = function(objectName, fullObject) {
  var props = {};
  var required = fullObject.required || [];
  var object = fullObject['properties'] ? fullObject['properties'] : fullObject;
  
  _.forEach(object, function(property, key) {
    var schemaProperty = getSchemaProperty(property, key, required, objectName, object);
    props = _.extend(props, schemaProperty);
  });
  
  return props;
};

var getSchemaProperty = function(property, key, required, objectName, object) {
  var props = {};
  if (isMongodbReserved(key) === true) {
    return;
  }
  
  if (isMongooseProperty(property)) {
    props[key] = getMongooseSpecific(props, property);
  }
  else if (isMongooseArray(property)) {
    props[key] = [getMongooseSpecific(props, property)];
  }
  else if (isPropertyHasRef(property)) {
    processRef(property, objectName, props, key, required);
  }
  else if (property.type !== 'object') {
    var type = propertyMap(property);
    //support array of enum with multiple values now
    if (property.items && property.items.enum && _.isArray(property.items.enum)) {
      props[key] = [{type: String, enum: property.items.enum}];
    } else if (property.enum && _.isArray(property.enum)) {
      props[key] = {type: type, enum: property.enum};
    } else {
      props[key] = {type: type};
    }
  }
  else if (property.type === 'object') {
    if (property['properties']) {
      props[key] = getSchema(key, property);
      //props[key].type = Schema.Types.Mixed;
    } else {
      props[key] = {};
    }
  }
  else if (isSimpleSchema(object)) {
    props = {type: propertyMap(object)};
  }
  if (required) {
    fillRequired(props, key, required);
  }
  //support default
  if (property.hasOwnProperty('mdefault')) {
    props[key]["default"] = (property.mdefault == "now") ? Date.now : property.mdefault;
  }
  return props;
};

var processDocumentIndex = function(schema, index) {
  //TODO: check indicies are numbers
  var isUniqueIndex = false;
  if (_.isEmpty(index)) {
    return;
  }
  if (index.unique) {
    isUniqueIndex = true;
  }
  delete index.unique;
  if (isUniqueIndex) {
    schema.index(index, {unique: true})
  } else {
    schema.index(index)
  }
  
};

module.exports.compileAsync = function(spec, callback) {
  try {
    callback(null, this.compile(spec));
  } catch (err) {
    callback({message: err}, null);
  }
};

module.exports.compile = function(spec, _extraDefinitions) {
  if (!spec) throw new Error('Swagger spec not supplied');
  var swaggerJSON = convertToJSON(spec);
  if (swaggerJSON.swagger) {
    swaggerVersion = new Number(swaggerJSON.swagger);
  }
  
  definitions = swaggerJSON['definitions'];
  
  applyExtraDefinitions(definitions, _extraDefinitions);
  
  var customMongooseProperty = getMongooseProperty();
  
  if (swaggerJSON[customMongooseProperty]) {
    processMongooseDefinition(customMongooseProperty, swaggerJSON[customMongooseProperty]);
  }
  //for recompilation  (ex test case) reinit nextedschemas
  var schemas = xSwaggerMongoose.nextedschemas = {};
  _.forEach(definitions, function(definition, key) {
    var object;
    var options = xSwaggerMongoose.schemaOptions;
    var excludedSchema = xSwaggerMongoose.excludeSchema;
    //this mods else documentIndex is not a ref to a var and we wont change it after processMongooseDefinition
    var documentIndex = xSwaggerMongoose.documentIndex;
    
    if (xSwaggerMongoose.nextedschemas[key]) {
      //this schema was already parsed (from nested properties)
      schemas[key] = xSwaggerMongoose.nextedschemas[key];
      return;
    }
    
    if (definition[customMongooseProperty]) {
      processMongooseDefinition(key, definition[customMongooseProperty]);
    }
    if (excludedSchema[key]) {
      return;
    }
    object = getSchema(key, definition);
    if (options) {
      var opt = options[customMongooseProperty] ? options[customMongooseProperty] : {};
      options = _.extend(opt, options[key]);
    }
    
    if (typeof excludedSchema === 'object') {
      excludedSchema = excludedSchema[customMongooseProperty] || excludedSchema[key];
    }
    if (typeof documentIndex === 'object') {
      documentIndex = documentIndex[customMongooseProperty] || documentIndex[key];
    }
    if (object && !excludedSchema) {
      var additionalProperties = _.extend({}, xSwaggerMongoose.additionalProperties[customMongooseProperty], xSwaggerMongoose.additionalProperties[key]);
      additionalProperties = processAdditionalProperties(additionalProperties, key)
      object = _.extend(object, additionalProperties);
      var schema = new mongoose.Schema(object, options);
      processDocumentIndex(schema, documentIndex);
      schemas[key] = schema;
      //save the parse to not do it again in case of duplicate (in nested)
      xSwaggerMongoose.nextedschemas[key] = schema;
    }
  });
  
  var models = {};
  _.forEach(schemas, function(schema, key) {
    models[key] = mongoose.model(key, schema);
  });
  
  return {
    schemas: schemas,
    models: models
  };
};

var processMongooseDefinition = function(key, customOptions) {
  if (customOptions) {
    if (customOptions['schema-options']) {
      xSwaggerMongoose.schemaOptions[key] = customOptions['schema-options'];
    }
    if (customOptions['exclude-schema']) {
      xSwaggerMongoose.excludeSchema[key] = customOptions['exclude-schema'];
    }
    if (customOptions['additional-properties']) {
      xSwaggerMongoose.additionalProperties[key] = customOptions['additional-properties'];
    }
    if (customOptions['index']) {
      xSwaggerMongoose.documentIndex[key] = customOptions['index'];
    }
    if (customOptions['validators']) {
      var validatorsDirectory = path.resolve(process.cwd(), customOptions['validators'])
      validators = require(validatorsDirectory)
    }
    
  }
};

var processAdditionalProperties = function(additionalProperties, objectName) {
  var props = {};
  var customMongooseProperty = getMongooseProperty();
  _.each(additionalProperties, function(property, key) {
    //  var modifiedProperty = {};
    //   modifiedProperty[customMongooseProperty] = property;
    // not good for array of x-swagger-mongoose
    props = _.extend(props, getSchemaProperty(property, key, property.required, objectName));
  });
  return props;
};
