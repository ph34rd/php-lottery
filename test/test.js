'use strict';

var http = require('http'),
	cluster = require('cluster'),
	request = require('request'),
	async = require('async'),
	mysql = require('mysql'),
	numCPUs = require('os').cpus().length;

// params
var MAX_USERS = 100;
var MAX_CODES = 1000;
var CONCURENCY = 8;
var SOCKET_TIMEOUT = 10000;
var FREE_SOCKETS = 256;
var KEEP_ALIVE_TIMEOUT = 2000;
var API_HOST = 'localhost';
var DB_HOST = 'localhost';
var DB_USER = 'root';
var DB_PASS = '';
var DB_NAME = 'lottery';
var DELIMITER = '===================================';

function makeId()
{
	var str = '';
	var alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

	for(var i = 0; i < 5; i++) {
		str += alpha.charAt(Math.floor(Math.random() * alpha.length));
	}

	return str;
}

function requestMeter(options, done) {
	var start = process.hrtime();
	request(options, function(err, res, body, time) {
		done(err, res, body, parseInt(process.hrtime(start)[1] / 1000000, 10));
	});
}

function mysqlValidate(done) {
	var conn = mysql.createConnection({
		host: DB_HOST,
		user: DB_USER,
		password: DB_PASS,
		database: DB_NAME
	});

	conn.connect();

	async.series([
		function(cb) {
			conn.query('SHOW ENGINE INNODB STATUS', function(err, rows, fields) {
				if (err) {
					cb(err);
				} else {
					cb(null, rows);
				}
			});
		},
		function(cb) {
			conn.query('SELECT COUNT(*) as c FROM activated', function(err, rows, fields) {
				if (err) {
					cb(err);
				} else {
					cb(null, rows);
				}
			});
		},
		function(cb) {
			conn.query("SELECT value FROM counters WHERE name='a'", function(err, rows, fields) {
				if (err) {
					cb(err);
				} else {
					cb(null, rows);
				}
			});
		},
		function(cb) {
			conn.query("SELECT SUM(wins) as summary FROM users ORDER BY summary", function(err, rows, fields) {
				if (err) {
					cb(err);
				} else {
					cb(null, rows);
				}
			});
		}
	],
	function(err, results) {
		conn.end();

		if (err) {
			done(err);
		} else {
			var test = [];
			// check innodb log
			var innolog = (results[0][0] && results[0][0].Status) ? results[0][0].Status.toString() : '';
			// LATEST DETECTED DEADLOCK
			test.push({
				name: 'DEADLOCK',
				result: !innolog.match(/LATEST DETECTED DEADLOCK/m)
			});

			// real activated count
			var real = (results[1][0] && results[1][0].c) ? +(results[1][0].c) : 0;
			// counter activated
			var counter = (results[2][0] && results[2][0].value) ? +(results[2][0].value) : 0;
			test.push({
				name: 'COUNTER COLLISION',
				result: (real === counter)
			});

			// sum wins
			var wins = (results[3][0] && results[3][0].summary) ? +(results[3][0].summary) : 0;
			test.push({
				name: 'WINS COLLISION',
				result: (Math.floor(real/10) === wins)
			});

			done(err, test);
		}
	});
}

if (cluster.isMaster) {
	(function() {
		var results = [];
		var workers = numCPUs;

		console.log(DELIMITER);
		console.log('WORKERS: ' + workers);

		cluster.on('exit', function(worker, code, signal) {
			console.log('WORKER ' + worker.process.pid + ' DONE');
			workers--;
			if (workers === 0) {
				console.log(results.length + ' REQUESTS DONE');

				console.log(DELIMITER);

				var cError = 0,
					pError = 0,
					prize = 0,
					success = 0,
					repeat = 0,
					exceed = 0,
					wrong = 0,
					time = 0;
				for (var i = 0; i < results.length; i++) {
					var res = results[i];

					time += res.time;
					if (i > 0) {
						time = time/2;
					}

					if ((res.err) || (res.status !== 200)) {
						if (res.err) {
							cError++;
						} else {
							pError++;
						}
					} else if (res.body === 'CODE_SUCCESS') {
						success++;
					} else if (res.body === 'CODE_PRIZE') {
						prize++;
					} else if (res.body === 'CODE_REPEAT') {
						repeat++;
					} else if (res.body === 'WINS_LIMIT_EXCEEDED') {
						exceed++;
					} else if (res.body === 'CODE_WRONG') {
						wrong++;
					}
				}
				time = Math.ceil(time/2);

				console.log('PRIZE: ' + prize);
				console.log('SUCCESS: ' + success);
				console.log('REPEAT: ' + repeat);
				console.log('WINS_LIMIT_EXCEEDED: ' + exceed);
				console.log('WRONG: ' + wrong);
				console.log('AVG. TIME: ' + time);
				console.log('APP_ERROR: ' + pError);
				console.log('CONNECTION_ERROR: ' + cError);
				console.log(DELIMITER);

				mysqlValidate(function(err, test) {
					var exitCode = 0;

					if (err) {
						console.log('MYSQL FAILED: ' + err.message);
						console.log(DELIMITER);
						exitCode = 1;
					} else {
						for (var i = 0; i < test.length; i++) {
							if (test[i].result) {
								console.log('SUCCESS: ' + test[i].name);
							} else {
								exitCode = 1;
								console.log('FAIL: ' + test[i].name);
							}
							console.log(DELIMITER);
						}
					}

					process.exit(exitCode);
				});
			}
		});

		for (var i = 0; i < numCPUs; i++) {
			var worker = cluster.fork();
			if (worker) {
				worker.on('message', function(msg) {
					results.push(msg);
				});
			}
		}
	})();
} else {
	(function() {
		var agent = new http.Agent({
			keepAlive: true,
			keepAliveMsecs: KEEP_ALIVE_TIMEOUT,
			maxSockets: Infinity,
			maxFreeSockets: FREE_SOCKETS
		});

		var q = async.queue(function(task, done) {
			requestMeter({
				url: 'http://' + API_HOST + '/?user=' + task.user + '&code=' + task.code,
				timeout: SOCKET_TIMEOUT,
				agent: agent
			}, function(err, res, body, time) {
				if (err) {
					process.send({
						'code': task.code,
						'user': task.user,
						'time': time,
						'err': err.message
					});
				} else {
					process.send({
						'code': task.code,
						'user': task.user,
						'time': time,
						'status': res.statusCode,
						'body': body
					});
				}
				done();
			});
		}, CONCURENCY);

		var users = [];
		for (var i = 0; i < MAX_USERS; i++) {
			users.push(makeId());
		}

		for (i = 0; i < MAX_CODES; i++) {
			q.push({
				user: users[Math.floor(Math.random() * MAX_USERS)],
				code: makeId()
			}, function() {
				if (q.idle() === true) {
					q.kill();
					process.disconnect();
				}
			});
		}
	})();
}
