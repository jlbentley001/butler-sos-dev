var mqtt = require('mqtt');
var config = require('config');

const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');
var dgram = require('dgram');
const si = require('systeminformation');
const os = require('os');
let crypto = require('crypto');

// const verifyConfig = require('./lib/verifyConfig');

const Influx = require('influx');
const { Pool } = require('pg');

// Get app version from package.json file
var appVersion = require('./package.json').version;

// Set up array for storing app ids and names
var appNames = [];

// Set up logger with timestamps and colors, and optional logging to disk file
const logTransports = [];

logTransports.push(
    new winston.transports.Console({
        name: 'console',
        level: config.get('Butler-SOS.logLevel'),
        format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.colorize(),
            winston.format.simple(),
            winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`),
        ),
    }),
);

if (config.get('Butler-SOS.fileLogging')) {
    logTransports.push(
        new winston.transports.DailyRotateFile({
            dirname: path.join(__dirname, config.get('Butler-SOS.logDirectory')),
            filename: 'butler-sos.%DATE%.log',
            level: config.get('Butler-SOS.logLevel'),
            datePattern: 'YYYY-MM-DD',
            maxFiles: '30d',
        }),
    );
}

var logger = winston.createLogger({
    transports: logTransports,
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`),
    ),
});

// Function to get current logging level
const getLoggingLevel = () => {
    return logTransports.find(transport => {
        return transport.name == 'console';
    }).level;
};

// ------------------------------------
// UDP server connection parameters
var udpServer = {};
try {
    udpServer.host = config.has('Butler-SOS.userEvents.udpServerConfig.serverHost')
        ? config.get('Butler-SOS.userEvents.udpServerConfig.serverHost')
        : '';

    // Prepare to listen on port X for incoming UDP connections regarding user activity events
    udpServer.userActivitySocket = dgram.createSocket({
        type: 'udp4',
        reuseAddr: true,
    });

    udpServer.portUserActivity = config.has('Butler-SOS.userEvents.udpServerConfig.portUserActivityEvents')
        ? config.get('Butler-SOS.userEvents.udpServerConfig.portUserActivityEvents')
        : '';
} catch (err) {
    logger.error(`CONFIG: Setting up UDP user activity listener: ${err}`);
}

// ------------------------------------
// Get info on what servers to monitor
const serverList = config.get('Butler-SOS.serversToMonitor.servers');

// Set up connection pool for accessing Qlik Sense log db
const pgPool = new Pool({
    host: config.get('Butler-SOS.logdb.host'),
    database: 'QLogs',
    user: config.get('Butler-SOS.logdb.qlogsReaderUser'),
    password: config.get('Butler-SOS.logdb.qlogsReaderPwd'),
    port: config.get('Butler-SOS.logdb.port'),
});

// the pool will emit an error on behalf of any idle clients
// it contains if a backend error or network partition happens
// eslint-disable-next-line no-unused-vars
pgPool.on('error', (err, client) => {
    logger.error(`CONFIG: Unexpected error on idle client: ${err}`);
    // process.exit(-1);
});

// Get list of standard and user configurable tags
// ..begin with standard tags
let tagValues = ['host', 'server_name', 'server_description'];

// ..check if there are any extra tags for this server that should be sent to InfluxDB
if (config.has('Butler-SOS.serversToMonitor.serverTagsDefinition')) {
    // Loop over all tags defined for the current server, adding them to the data structure that will later be passed to Influxdb
    config.get('Butler-SOS.serversToMonitor.serverTagsDefinition').forEach(entry => {
        logger.debug(`CONFIG: Setting up new Influx database: Found server tag : ${entry}`);

        tagValues.push(entry);
    });
}

// Log events need a couple of extra tags
let tagValuesLogEvent = tagValues.slice();
tagValuesLogEvent.push('source_process');
tagValuesLogEvent.push('log_level');

logger.info(`CONFIG: Influxdb enabled: ${config.get('Butler-SOS.influxdbConfig.enableInfluxdb')}`);
logger.info(`CONFIG: Influxdb host IP: ${config.get('Butler-SOS.influxdbConfig.hostIP')}`);
logger.info(`CONFIG: Influxdb host port: ${config.get('Butler-SOS.influxdbConfig.hostPort')}`);
logger.info(`CONFIG: Influxdb db name: ${config.get('Butler-SOS.influxdbConfig.dbName')}`);

// Set up Influxdb client
const influx = new Influx.InfluxDB({
    host: config.get('Butler-SOS.influxdbConfig.hostIP'),
    port: `${config.has('Butler-SOS.influxdbConfig.hostPort')
        ? config.get('Butler-SOS.influxdbConfig.hostPort')
        : '8086'}`,
    database: config.get('Butler-SOS.influxdbConfig.dbName'),
    username: `${config.get('Butler-SOS.influxdbConfig.auth.enable')
        ? config.get('Butler-SOS.influxdbConfig.auth.username')
        : ''
    }`,
    password: `${config.get('Butler-SOS.influxdbConfig.auth.enable')
        ? config.get('Butler-SOS.influxdbConfig.auth.password')
        : ''}`,
    schema: [
        {
            measurement: 'sense_server',
            fields: {
                version: Influx.FieldType.STRING,
                started: Influx.FieldType.STRING,
                uptime: Influx.FieldType.STRING,
            },
            tags: tagValues,
        },
        {
            measurement: 'mem',
            fields: {
                comitted: Influx.FieldType.INTEGER,
                allocated: Influx.FieldType.INTEGER,
                free: Influx.FieldType.INTEGER,
            },
            tags: tagValues,
        },
        {
            measurement: 'apps',
            fields: {
                active_docs_count: Influx.FieldType.INTEGER,
                loaded_docs_count: Influx.FieldType.INTEGER,
                in_memory_docs_count: Influx.FieldType.INTEGER,
                active_docs: Influx.FieldType.STRING,
                active_docs_names: Influx.FieldType.STRING,
                active_session_docs_names: Influx.FieldType.STRING,
                loaded_docs: Influx.FieldType.STRING,
                loaded_docs_names: Influx.FieldType.STRING,
                loaded_session_docs_names: Influx.FieldType.STRING,
                in_memory_docs: Influx.FieldType.STRING,
                in_memory_docs_names: Influx.FieldType.STRING,
                in_memory_session_docs_names: Influx.FieldType.STRING,
                calls: Influx.FieldType.INTEGER,
                selections: Influx.FieldType.INTEGER,
            },
            tags: tagValues,
        },
        {
            measurement: 'cpu',
            fields: {
                total: Influx.FieldType.INTEGER,
            },
            tags: tagValues,
        },
        {
            measurement: 'session',
            fields: {
                active: Influx.FieldType.INTEGER,
                total: Influx.FieldType.INTEGER,
            },
            tags: tagValues,
        },
        {
            measurement: 'users',
            fields: {
                active: Influx.FieldType.INTEGER,
                total: Influx.FieldType.INTEGER,
            },
            tags: tagValues,
        },
        {
            measurement: 'cache',
            fields: {
                hits: Influx.FieldType.INTEGER,
                lookups: Influx.FieldType.INTEGER,
                added: Influx.FieldType.INTEGER,
                replaced: Influx.FieldType.INTEGER,
                bytes_added: Influx.FieldType.INTEGER,
            },
            tags: tagValues,
        },
        {
            measurement: 'log_event',
            fields: {
                message: Influx.FieldType.STRING,
            },
            tags: tagValuesLogEvent,
        },
        {
            measurement: 'butlersos_memory_usage',
            fields: {
                heap_used: Influx.FieldType.FLOAT,
                heap_total: Influx.FieldType.FLOAT,
                process_memory: Influx.FieldType.FLOAT,
            },
            tags: ['butler_sos_instance'],
        },
        // {
        //     measurement: 'user_events',
        //     fields: {
        //         userFull: Influx.FieldType.STRING,
        //         userId: Influx.FieldType.STRING
        //     },
        //     tags: ['host', 'event_action', 'userFull', 'userDirectory', 'userId', 'origin']
        // },
    ],
});

function initInfluxDB() {
    const dbName = config.get('Butler-SOS.influxdbConfig.dbName');
    const enableInfluxdb = config.get('Butler-SOS.influxdbConfig.enableInfluxdb');

    if (enableInfluxdb) {
        influx
            .getDatabaseNames()
            .then(names => {
                if (!names.includes(dbName)) {
                    influx
                        .createDatabase(dbName)
                        .then(() => {
                            logger.info(`CONFIG: Created new InfluxDB database: ${dbName}`);

                            const newPolicy = config.get(
                                'Butler-SOS.influxdbConfig.retentionPolicy',
                            );

                            // Create new default retention policy
                            influx
                                .createRetentionPolicy(newPolicy.name, {
                                    database: dbName,
                                    duration: newPolicy.duration,
                                    replication: 1,
                                    isDefault: true,
                                })
                                .then(() => {
                                    logger.info(
                                        `CONFIG: Created new InfluxDB retention policy: ${newPolicy.name}`,
                                    );
                                })
                                .catch(err => {
                                    logger.error(
                                        `CONFIG: Error creating new InfluxDB retention policy "${newPolicy.name}"! ${err.stack}`,
                                    );
                                });
                        })
                        .catch(err => {
                            logger.error(
                                `CONFIG: Error creating new InfluxDB database "${dbName}"! ${err.stack}`,
                            );
                        });
                } else {
                    logger.info(`CONFIG: Found InfluxDB database: ${dbName}`);
                }
            })
            .catch(err => {
                logger.error(`CONFIG: Error getting list of InfluxDB databases! ${err.stack}`);
            });
    }
}

// ------------------------------------
// Create MQTT client object and connect to MQTT broker
var mqttClient = mqtt.connect({
    port: config.get('Butler-SOS.mqttConfig.brokerPort'),
    host: config.get('Butler-SOS.mqttConfig.brokerHost'),
});

/*
  Following might be needed for conecting to older Mosquitto versions
  var mqttClient  = mqtt.connect('mqtt://<IP of MQTT server>', {
    protocolId: 'MQIsdp',
    protocolVersion: 3
  });
*/

// Anon telemetry reporting
var hostInfo;

async function initHostInfo() {
    try {
        const siCPU = await si.cpu(),
            siSystem = await si.system(),
            siMem = await si.mem(),
            siOS = await si.osInfo(),
            siDocker = await si.dockerInfo(),
            siNetwork = await si.networkInterfaces(),
            siNetworkDefault = await si.networkInterfaceDefault();

        let defaultNetworkInterface = siNetworkDefault;

        let networkInterface = siNetwork.filter(item => {
            return item.iface === defaultNetworkInterface;
        });

        let idSrc = networkInterface[0].mac + networkInterface[0].ip4 + config.get('Butler-SOS.logdb.host') + siSystem.uuid;
        let salt = networkInterface[0].mac;
        let hash = crypto.createHmac('sha256', salt);
        hash.update(idSrc);
        let id = hash.digest('hex');


        hostInfo = {
            id: id,
            node: {
                nodeVersion: process.version,
                versions: process.versions
            },
            os: {
                platform: os.platform(),
                release: os.release(),
                version: os.version(),
                arch: os.arch(),
                cpuCores: os.cpus().length,
                type: os.type(),
                totalmem: os.totalmem(),
            },
            si: {
                cpu: siCPU,
                system: siSystem,
                memory: {
                    total: siMem.total,
                },
                os: siOS,
                network: siNetwork,
                networkDefault: siNetworkDefault,
                docker: siDocker,
            },
        };

        return hostInfo;
    } catch (err) {
        logger.error(`CONFIG: Getting host info: ${err}`);
    }
}

module.exports = {
    config,
    mqttClient,
    logger,
    getLoggingLevel,
    influx,
    pgPool,
    appVersion,
    serverList,
    initInfluxDB,
    appNames,
    udpServer,
    initHostInfo,
    hostInfo,
};
