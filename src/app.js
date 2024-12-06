const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { TIMEOUTS } = require('./config/constants');
const UartService = require('./services/UartService');
const ApiService = require('./services/ApiService');
const DatabaseService = require('./services/DatabaseService');
const FuelStateMachine = require('./state-machine/FuelStateMachine');
const ApiRoutes = require('./routes/api');
const { Logger } = require('./utils/helpers');

class FuelAutomationSystem {
    constructor() {
        this.app = express();
        this.logger = new Logger( {minLevel:'debug'});
        this.services = {};
        this.stateMachine = null;
    }

    async initialize() {
        try {
            // Initialize Express middleware
            this.setupExpress();

            // Initialize services
            await this.initializeServices();

            // Initialize state machine
            await this.initializeStateMachine();

            // Setup routes
            this.setupRoutes();

            // Setup error handling
            this.setupErrorHandling();

            this.logger.info('Fuel Automation System initialized successfully');
            return true;
        } catch (error) {
            this.logger.error('Failed to initialize Fuel Automation System', { error });
            throw error;
        }
    }

    setupExpress() {
        // Basic security
        this.app.use(helmet());
        
        // CORS
        this.app.use(cors());
        
        // Body parsing
        this.app.use(express.json());
        this.app.use(express.urlencoded({ extended: true }));
        
        // Request logging
        this.app.use((req, res, next) => {
            this.logger.debug(`${req.method} ${req.path}`, { 
                query: req.query,
                body: req.body 
            });
            next();
        });
    }

    async initializeServices() {
        try {
            // Initialize UART service
            this.services.uart = new UartService();
            await this.services.uart.initialize();

            // Setup UART response handling
            this.services.uart.on('data', async (data) => {
                if (this.stateMachine) {
                    await this.stateMachine.handleUartResponse(data);
                }
            });


            this.logger.info('UART service initialized');

            // Initialize API service
            this.services.api = new ApiService();
            await this.services.api.initialize();
            this.logger.info('API service initialized');

            // Initialize Database service
            this.services.db = new DatabaseService();
            await this.services.db.initialize();
            this.logger.info('Database service initialized');

        } catch (error) {
            this.logger.error('Service initialization failed', { error });
            throw error;
        }
    }

    async initializeStateMachine() {
        try {
            this.stateMachine = new FuelStateMachine(
                this.services.uart,
                this.services.api,
                this.services.db,
                this.logger
            );

            await this.stateMachine.initialize();
            this.logger.info('State machine initialized');

            // Setup state change logging
            this.stateMachine.on('stateChange', (event) => {
                this.logger.info('State changed', event);
            });

            // Start state processing loop
            this.startStateProcessing();

        } catch (error) {
            this.logger.error('State machine initialization failed', { error });
            throw error;
        }
    }

    setupRoutes() {
        const apiRoutes = new ApiRoutes(this.stateMachine, this.logger, this.services.uart);
        this.app.use('/api', apiRoutes.getRouter());

        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'ok',
                uptime: process.uptime(),
                timestamp: Date.now()
            });
        });
    }

    setupErrorHandling() {
        // 404 handler
        this.app.use((req, res) => {
            res.status(404).json({
                success: false,
                error: 'Not found'
            });
        });

        // Global error handler
        this.app.use((err, req, res, next) => {
            this.logger.error('Unhandled error', { error: err });
            res.status(500).json({
                success: false,
                error: 'Internal server error'
            });
        });
    }

    startStateProcessing() {
        setInterval(() => {
            this.stateMachine.processState().catch(error => {
                this.logger.error('State processing error', { error });
            });
        }, TIMEOUTS.STATE_PROCESSING_INTERVAL);
    }

    async start(port = 3000) {
        return new Promise((resolve, reject) => {
            try {
                // Handle process shutdown
                this.setupGracefulShutdown();

                // Start the server
                this.server = this.app.listen(port, () => {
                    this.logger.info(`Fuel Automation Server running on port ${port}`);
                    resolve(true);
                });

            } catch (error) {
                this.logger.error('Failed to start server', { error });
                reject(error);
            }
        });
    }

    setupGracefulShutdown() {
        process.on('SIGTERM', () => this.shutdown('SIGTERM'));
        process.on('SIGINT', () => this.shutdown('SIGINT'));

        process.on('uncaughtException', (error) => {
            this.logger.error('Uncaught exception', { error });
            this.shutdown('uncaughtException');
        });

        process.on('unhandledRejection', (error) => {
            this.logger.error('Unhandled rejection', { error });
            this.shutdown('unhandledRejection');
        });
    }

    async shutdown(signal) {
        this.logger.info(`Received ${signal}. Starting graceful shutdown...`);

        try {
            // Stop state processing
            if (this.stateProcessingInterval) {
                clearInterval(this.stateProcessingInterval);
            }

            // Close UART connection
            if (this.services.uart) {
                await this.services.uart.close();
            }

            // Close database connections
            if (this.services.db) {
                await this.services.db.close();
            }

            // Close HTTP server
            if (this.server) {
                this.server.close();
            }

            this.logger.info('Graceful shutdown completed');
            process.exit(0);
        } catch (error) {
            this.logger.error('Error during shutdown', { error });
            process.exit(1);
        }
    }
}

// Create and start the application
if (require.main === module) {
    const app = new FuelAutomationSystem();
    app.initialize()
        .then(() => app.start())
        .catch(error => {
            console.error('Failed to start application:', error);
            process.exit(1);
        });
}

module.exports = FuelAutomationSystem;