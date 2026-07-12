const { ValidationError } = require('../utils/errors');

/** validate({ body, params, query }) - each is an optional Joi schema. */
function validate(schemas) {
  return (req, res, next) => {
    for (const key of ['params', 'query', 'body']) {
      const schema = schemas[key];
      if (!schema) continue;
      const { error, value } = schema.validate(req[key], { abortEarly: false, stripUnknown: true });
      if (error) {
        return next(
          new ValidationError(error.details.map((d) => ({ field: d.path.join('.'), message: d.message })))
        );
      }
      req[key] = value;
    }
    next();
  };
}

module.exports = validate;
