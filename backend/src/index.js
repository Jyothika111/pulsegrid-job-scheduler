require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const logger = require('./utils/logger');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const attachWebsocket = require('./websocket');
const eventBus = require('./services/eventBus');
const schedulerService = require('./services/schedulerService');

const authRoutes = require('./routes/authRoutes');
const projectRoutes = require('./routes/projectRoutes');
const queueRoutes = require('./routes/queueRoutes');
const jobRoutes = require('./routes/jobRoutes');
const workerRoutes = require('./routes/workerRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');

const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '1mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev', {
  stream: { write: (msg) => logger.info(msg.trim()) },
}));

// Global API rate limit (separate from per-queue job-start rate limiting):
// protects the control plane itself from abuse.
app.use(
  '/api/',
  rateLimit({
    windowMs: 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/queues', queueRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/workers', workerRoutes);
app.use('/api/dashboard', dashboardRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

const PORT = process.env.PORT || 4000;
const server = http.createServer(app);
attachWebsocket(server);

eventBus
  .connect()
  .catch((err) => logger.warn('EventBus connect failed', { error: err.message }))
  .finally(() => {
    schedulerService.start(5000);
    server.listen(PORT, () => logger.info(`API server listening on :${PORT}`));
  });

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down');
  schedulerService.stop();
  server.close(() => process.exit(0));
});

module.exports = app;
