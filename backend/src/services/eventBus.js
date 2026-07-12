const { EventEmitter } = require('events');
const Redis = require('ioredis');
const logger = require('../utils/logger');

const CHANNEL = 'scheduler:events';

/**
 * Event-driven execution (bonus feature): the worker process and API
 * process are separate Node processes (by design - so you can scale
 * workers independently of the API). A local EventEmitter alone can't
 * bridge that gap, so we publish every domain event to a Redis pub/sub
 * channel; whichever process cares (the API process, for WebSocket
 * fan-out to dashboards) subscribes and re-emits locally.
 *
 * Event types: job.created, job.claimed, job.started, job.completed,
 * job.failed, job.retrying, job.dead, worker.registered, worker.heartbeat,
 * worker.offline, queue.updated.
 */
class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this.publisher = null;
    this.subscriber = null;
  }

  async connect() {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    this.publisher = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    this.subscriber = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    this.publisher.on('error', (e) => logger.warn('EventBus publisher error', { error: e.message }));
    this.subscriber.on('error', (e) => logger.warn('EventBus subscriber error', { error: e.message }));
    try {
      await this.publisher.connect();
      await this.subscriber.connect();
      await this.subscriber.subscribe(CHANNEL);
      this.subscriber.on('message', (_channel, raw) => {
        try {
          const { type, payload } = JSON.parse(raw);
          this.emit(type, payload);
          this.emit('*', { type, payload });
        } catch (err) {
          logger.warn('Failed to parse event bus message', { error: err.message });
        }
      });
      logger.info('EventBus connected to Redis pub/sub');
    } catch (err) {
      logger.warn('EventBus Redis unavailable - falling back to in-process only', { error: err.message });
    }
  }

  /** Publishes a domain event to every connected process (including this one, via Redis echo). */
  async publish(type, payload) {
    // Always emit locally immediately (don't wait on Redis round-trip for
    // same-process listeners).
    this.emit(type, payload);
    this.emit('*', { type, payload });
    if (this.publisher && this.publisher.status === 'ready') {
      try {
        await this.publisher.publish(CHANNEL, JSON.stringify({ type, payload }));
      } catch (err) {
        logger.warn('EventBus publish failed', { error: err.message });
      }
    }
  }
}

module.exports = new EventBus();
