<?php

error_reporting(E_ALL);
ini_set('display_errors', 0);
ignore_user_abort(true);
date_default_timezone_set('UTC');

require __DIR__.'/../vendor/autoload.php';

use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Validator\Constraints as Assert;
use Doctrine\DBAL\Connection;
use Symfony\Component\Debug\ErrorHandler;
use Symfony\Component\Debug\ExceptionHandler;

ErrorHandler::register();
ExceptionHandler::register()->setHandler(function (\Exception $e) {
	print('INTERNAL_ERROR');
});

$app = new \Silex\Application();
$app['debug'] = false;

$app->register(new \Silex\Provider\DoctrineServiceProvider(), array(
	'db.options' => array(
		'driver' => 'pdo_mysql',
		'host' => '127.0.0.1',
		'dbname' => 'lottery',
		'user' => 'root',
		'password' => '',
		'charset' => 'utf8mb4',
	),
));

$app->register(new \Silex\Provider\ValidatorServiceProvider());

$app->error(function (\Exception $e, $code) use ($app) {
	if ($code === 404) {
		return new Response('NOT_FOUND', $code);
	}
	return new Response('INTERNAL_ERROR', $code);
});

$app->get('/', function (Request $req) use ($app) {
	$params = $req->query->all();

	$constraint = new Assert\Collection(array(
		'user' => new Assert\Regex(array('pattern' => '/^[A-Za-z0-9]{5}$/')),
		'code' => new Assert\Regex(array('pattern' => '/^[A-Za-z0-9]{5}$/')),
	));

	$errors = $app['validator']->validateValue($params, $constraint);
	if (count($errors) > 0) {
		return 'CODE_WRONG';
	}

	$app['db']->setTransactionIsolation(Connection::TRANSACTION_READ_COMMITTED);
	$app['db']->beginTransaction();

	try {
		// find user for update
		$sql = 'SELECT wins FROM users WHERE name = ? FOR UPDATE';
		$user = $app['db']->fetchAssoc($sql, array((string) $params['user']));

		$needUserInsert = false;
		if (!$user) {
			$needUserInsert = true;
			$user = array('name' => (string) $params['user'], 'wins' => 0);
		}

		if ($user['wins'] >= 3) {
			$app['db']->rollback();
			return 'WINS_LIMIT_EXCEEDED';
		}

		// check code for duplicates
		$sql = 'SELECT id FROM activated WHERE code = ?';
		$code = $app['db']->fetchAssoc($sql, array((string) $params['code']));

		if ($code) {
			$app['db']->rollback();
			return 'CODE_REPEAT';
		}

		// get counter value
		$sql = 'SELECT value FROM counters WHERE name = ? FOR UPDATE';
		$counter = $app['db']->fetchAssoc($sql, array('a'));

		if (!$counter) {
			$counter = array('name' => 'a', 'value' => 1);
			$app['db']->insert('counters', $counter);
		} else {
			$app['db']->update('counters', array('value' => $counter['value'] + 1), array('name' => 'a'));
			$counter['value'] += 1;
		}

		// insert new code
		$app['db']->insert('activated', array('code' => (string) $params['code']));

		// check for winner
		if (($counter['value'] % 10) === 0) {
			$user['wins']++;
			if ($needUserInsert) {
				$app['db']->insert('users', $user);
			} else {
				$app['db']->update('users', array('wins' => $user['wins']), array('name' => (string) $params['user']));
			}
			$app['db']->commit();
			return 'CODE_PRIZE';
		}

		$app['db']->commit();
		return 'CODE_SUCCESS';

	} catch (\Exception $e) {
		$app['db']->rollback();
		throw $e;
	}
});

$app->run();
