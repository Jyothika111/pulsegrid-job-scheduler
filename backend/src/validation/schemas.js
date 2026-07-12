const Joi = require('joi');

const id = Joi.string().uuid();

const pagination = {
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(20),
};

const auth = {
  register: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().min(8).max(128).required(),
    name: Joi.string().min(1).max(120).required(),
    orgName: Joi.string().max(120).optional(),
  }),
  login: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().required(),
  }),
};

const project = {
  create: Joi.object({
    organizationId: id.required(),
    name: Joi.string().min(1).max(120).required(),
    description: Joi.string().allow('').max(2000).optional(),
  }),
};

const queue = {
  create: Joi.object({
    projectId: id.required(),
    name: Joi.string().min(1).max(120).required(),
    priority: Joi.number().integer().min(0).max(100).default(0),
    concurrencyLimit: Joi.number().integer().min(1).max(1000).default(5),
    shardCount: Joi.number().integer().min(1).max(64).default(1),
    retryStrategy: Joi.string().valid('FIXED', 'LINEAR', 'EXPONENTIAL', 'NONE').default('EXPONENTIAL'),
    maxRetries: Joi.number().integer().min(0).max(50).default(3),
    baseRetryDelayMs: Joi.number().integer().min(0).default(2000),
    maxRetryDelayMs: Joi.number().integer().min(0).default(300000),
    rateLimitMax: Joi.number().integer().min(1).allow(null).default(null),
    rateLimitWindowMs: Joi.number().integer().min(100).default(1000),
    defaultTimeoutMs: Joi.number().integer().min(100).default(30000),
  }),
  update: Joi.object({
    name: Joi.string().min(1).max(120),
    priority: Joi.number().integer().min(0).max(100),
    concurrencyLimit: Joi.number().integer().min(1).max(1000),
    shardCount: Joi.number().integer().min(1).max(64),
    retryStrategy: Joi.string().valid('FIXED', 'LINEAR', 'EXPONENTIAL', 'NONE'),
    maxRetries: Joi.number().integer().min(0).max(50),
    baseRetryDelayMs: Joi.number().integer().min(0),
    maxRetryDelayMs: Joi.number().integer().min(0),
    rateLimitMax: Joi.number().integer().min(1).allow(null),
    rateLimitWindowMs: Joi.number().integer().min(100),
    defaultTimeoutMs: Joi.number().integer().min(100),
    status: Joi.string().valid('ACTIVE', 'PAUSED'),
  }).min(1),
  list: Joi.object({ ...pagination, projectId: id.required() }),
};

const job = {
  create: Joi.object({
    queueId: id.required(),
    type: Joi.string().valid('IMMEDIATE', 'DELAYED', 'SCHEDULED', 'RECURRING', 'BATCH').required(),
    payload: Joi.object().default({}),
    priority: Joi.number().integer().min(0).max(100).default(0),
    runAt: Joi.date().iso().when('type', { is: 'SCHEDULED', then: Joi.required() }),
    delayMs: Joi.number().integer().min(0).default(0),
    cronExpr: Joi.string().when('type', { is: 'RECURRING', then: Joi.required() }),
    cronTimezone: Joi.string().default('UTC'),
    maxRetries: Joi.number().integer().min(0).max(50).optional(),
    retryStrategy: Joi.string().valid('FIXED', 'LINEAR', 'EXPONENTIAL', 'NONE').optional(),
    timeoutMs: Joi.number().integer().min(100).optional(),
    idempotencyKey: Joi.string().max(200).optional(),
    dependsOn: Joi.array().items(id).optional(), // bonus: workflow dependencies
  }),
  batchCreate: Joi.object({
    queueId: id.required(),
    jobs: Joi.array()
      .items(
        Joi.object({
          payload: Joi.object().default({}),
          priority: Joi.number().integer().min(0).max(100).default(0),
        })
      )
      .min(1)
      .max(1000)
      .required(),
  }),
  list: Joi.object({
    ...pagination,
    queueId: id.optional(),
    projectId: id.optional(),
    status: Joi.string()
      .valid('QUEUED', 'SCHEDULED', 'CLAIMED', 'RUNNING', 'COMPLETED', 'FAILED', 'DEAD', 'CANCELLED', 'WAITING_DEPENDENCY')
      .optional(),
    type: Joi.string().valid('IMMEDIATE', 'DELAYED', 'SCHEDULED', 'RECURRING', 'BATCH').optional(),
  }).or('queueId', 'projectId'),
};

const worker = {
  register: Joi.object({
    hostname: Joi.string().required(),
    pid: Joi.number().integer().optional(),
    queueNames: Joi.array().items(Joi.string()).min(1).required(),
    shardIds: Joi.array().items(Joi.number().integer()).default([0]),
    concurrency: Joi.number().integer().min(1).max(1000).default(5),
  }),
  heartbeat: Joi.object({
    jobsInFlight: Joi.number().integer().min(0).default(0),
    memoryMb: Joi.number().optional(),
    cpuPercent: Joi.number().optional(),
  }),
};

module.exports = { id, pagination, auth, project, queue, job, worker };
