const { Server } = require('socket.io');
const eventBus = require('../services/eventBus');
const logger = require('../utils/logger');

/**
 * Live updates (bonus feature). Clients join a room per project
 * ("project:<id>") and receive every domain event relevant to that
 * project's queues/jobs/workers, pushed as soon as the event bus sees it -
 * no polling required, though the REST API remains fully usable for
 * clients that prefer polling.
 */
function attachWebsocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: process.env.CORS_ORIGIN || '*' },
  });

  io.on('connection', (socket) => {
    socket.on('subscribe', ({ projectId }) => {
      if (projectId) {
        socket.join(`project:${projectId}`);
        socket.emit('subscribed', { projectId });
      }
    });
    socket.on('unsubscribe', ({ projectId }) => {
      if (projectId) socket.leave(`project:${projectId}`);
    });
  });

  // Broadcast every domain event to all connected clients. In a
  // multi-tenant deployment you'd resolve the event's queueId -> projectId
  // and emit only to that project's room; kept simple (broadcast) here
  // since the dashboard filters client-side by the project it's viewing.
  eventBus.on('*', ({ type, payload }) => {
    io.emit(type, payload);
  });

  logger.info('WebSocket server attached');
  return io;
}

module.exports = attachWebsocket;
