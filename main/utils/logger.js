const winston = require('winston');
const path    = require('path');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    process.env.NODE_ENV === 'production'
      ? winston.format.json()
      : winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, ...meta }) => {
            const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
            return `${timestamp} [${level}]: ${message}${metaStr}`;
          })
        )
  ),
  transports: [
    new winston.transports.Console(),
    // maxsize/maxFiles cap total disk usage at ~50MB per log (5x 10MB rotated files)
    // instead of growing unbounded — these had reached 500MB+ uncapped.
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/error.log'), level: 'error',
      maxsize: 10 * 1024 * 1024, maxFiles: 5, tailable: true,
    }),
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/combined.log'),
      maxsize: 10 * 1024 * 1024, maxFiles: 5, tailable: true,
    }),
  ]
});

module.exports = logger;
