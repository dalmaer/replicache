import {ReplicacheTest, httpStatusUnauthorized} from './replicache.js';
import type {ReplicacheOptions} from './replicache.js';
import {Replicache, TransactionClosedError} from './mod.js';

import type {ReadTransaction, WriteTransaction} from './mod.js';
import {deepEqual, JSONValue} from './json.js';

import {assert, expect} from '@esm-bundle/chai';
import * as sinon from 'sinon';
import type {SinonSpy} from 'sinon';

// fetch-mock has invalid d.ts file so we removed that on npm install.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error
import fetchMock from 'fetch-mock/esm/client.js';
import {Invoke, RPC} from './repm-invoker.js';
import type {ScanOptions} from './scan-options.js';

import {SinonFakeTimers, useFakeTimers} from 'sinon';

let clock: SinonFakeTimers;
setup(function () {
  clock = useFakeTimers(0);
});

teardown(function () {
  clock.restore();
});

async function tickAFewTimes(n = 10, time = 10) {
  for (let i = 0; i < n; i++) {
    await clock.tickAsync(time);
  }
}

fetchMock.config.overwriteRoutes = true;

const {fail} = assert;

let rep: ReplicacheTest | null = null;
let rep2: ReplicacheTest | null = null;

let overrideUseMemstore = false;

async function replicacheForTesting(
  name: string,
  {
    pullURL = 'https://pull.com/?name=' + name,
    pushDelay = 60_000, // Large to prevent interfering
    pushURL = 'https://push.com/?name=' + name,
    useMemstore = overrideUseMemstore,
    ...rest
  }: ReplicacheOptions = {},
): Promise<ReplicacheTest> {
  dbsToDrop.add(name);
  const rep = new ReplicacheTest({
    pullURL,
    pushDelay,
    pushURL,
    name,
    useMemstore,
    ...rest,
  });
  fetchMock.post(pullURL, {lastMutationID: 0, patch: []});
  fetchMock.post(pushURL, {});
  await tickAFewTimes();
  return rep;
}

const dbsToDrop = new Set<string>();

async function addData(tx: WriteTransaction, data: {[key: string]: JSONValue}) {
  for (const [key, value] of Object.entries(data)) {
    await tx.put(key, value);
  }
}

const emptyHash = '';

async function asyncIterableToArray<T>(it: AsyncIterable<T>) {
  const arr: T[] = [];
  for await (const v of it) {
    arr.push(v);
  }
  return arr;
}

function spyInvoke(
  rep: Replicache,
): SinonSpy<Parameters<Invoke>, ReturnType<Invoke>> {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  return sinon.spy(rep, '_invoke');
}

teardown(async () => {
  fetchMock.restore();
  sinon.restore();

  if (rep !== null && !rep.closed) {
    await rep.close();
    rep = null;
  }
  if (rep2 !== null && !rep2.closed) {
    await rep2.close();
    rep2 = null;
  }

  for (const name of dbsToDrop) {
    indexedDB.deleteDatabase(name);
  }
  dbsToDrop.clear();
});

async function expectPromiseToReject(p: unknown): Promise<Chai.Assertion> {
  let e;
  try {
    await p;
  } catch (ex) {
    e = ex;
  }
  return expect(e);
}

async function expectAsyncFuncToThrow(f: () => unknown, c: unknown) {
  (await expectPromiseToReject(f())).to.be.instanceof(c);
}

function testWithBothStores(name: string, func: () => Promise<void>) {
  for (const useMemstore of [false, true]) {
    test(`${name} {useMemstore: ${useMemstore}}`, async () => {
      try {
        overrideUseMemstore = useMemstore;
        await func();
      } finally {
        overrideUseMemstore = false;
      }
    });
  }
}

testWithBothStores('get, has, scan on empty db', async () => {
  rep = await replicacheForTesting('test2');
  async function t(tx: ReadTransaction) {
    expect(await tx.get('key')).to.equal(undefined);
    expect(await tx.has('key')).to.be.false;

    const scanItems = await asyncIterableToArray(tx.scan());
    expect(scanItems).to.have.length(0);
  }

  await t(rep);
});

testWithBothStores('put, get, has, del inside tx', async () => {
  rep = await replicacheForTesting('test3');
  const mut = rep.register(
    'mut',
    async (tx: WriteTransaction, args: {key: string; value: JSONValue}) => {
      const key = args['key'];
      const value = args['value'];
      await tx.put(key, value);
      expect(await tx.has(key)).to.equal(true);
      const v = await tx.get(key);
      expect(v).to.deep.equal(value);

      expect(await tx.del(key)).to.equal(true);
      expect(await tx.has(key)).to.be.false;
    },
  );

  for (const [key, value] of Object.entries({
    a: true,
    b: false,
    c: null,
    d: 'string',
    e: 12,
    f: {},
    g: [],
    h: {h1: true},
    i: [0, 1],
  })) {
    await mut({key, value: value as JSONValue});
  }
});

async function testScanResult<K, V>(
  options: ScanOptions | undefined,
  entries: [K, V][],
) {
  if (!rep) {
    fail();
    return;
  }

  await rep.query(async tx => {
    expect(
      await asyncIterableToArray(tx.scan(options).entries()),
    ).to.deep.equal(entries);
  });

  await rep.query(async tx => {
    expect(await asyncIterableToArray(tx.scan(options))).to.deep.equal(
      entries.map(([, v]) => v),
    );
  });

  await rep.query(async tx => {
    expect(await asyncIterableToArray(tx.scan(options).values())).to.deep.equal(
      entries.map(([, v]) => v),
    );
  });

  await rep.query(async tx => {
    expect(await asyncIterableToArray(tx.scan(options).keys())).to.deep.equal(
      entries.map(([k]) => k),
    );
  });
}

testWithBothStores('scan', async () => {
  rep = await replicacheForTesting('test4');
  const add = rep.register('add-data', addData);
  await add({
    'a/0': 0,
    'a/1': 1,
    'a/2': 2,
    'a/3': 3,
    'a/4': 4,
    'b/0': 5,
    'b/1': 6,
    'b/2': 7,
    'c/0': 8,
  });

  await testScanResult(undefined, [
    ['a/0', 0],
    ['a/1', 1],
    ['a/2', 2],
    ['a/3', 3],
    ['a/4', 4],
    ['b/0', 5],
    ['b/1', 6],
    ['b/2', 7],
    ['c/0', 8],
  ]);

  await testScanResult({prefix: 'a'}, [
    ['a/0', 0],
    ['a/1', 1],
    ['a/2', 2],
    ['a/3', 3],
    ['a/4', 4],
  ]);

  await testScanResult({prefix: 'b'}, [
    ['b/0', 5],
    ['b/1', 6],
    ['b/2', 7],
  ]);

  await testScanResult({prefix: 'c/'}, [['c/0', 8]]);

  await testScanResult(
    {
      start: {key: 'b/1', exclusive: false},
    },
    [
      ['b/1', 6],
      ['b/2', 7],
      ['c/0', 8],
    ],
  );

  await testScanResult(
    {
      start: {key: 'b/1'},
    },
    [
      ['b/1', 6],
      ['b/2', 7],
      ['c/0', 8],
    ],
  );

  await testScanResult(
    {
      start: {key: 'b/1', exclusive: true},
    },
    [
      ['b/2', 7],
      ['c/0', 8],
    ],
  );

  await testScanResult(
    {
      limit: 3,
    },
    [
      ['a/0', 0],
      ['a/1', 1],
      ['a/2', 2],
    ],
  );

  await testScanResult(
    {
      limit: 10,
      prefix: 'a/',
    },
    [
      ['a/0', 0],
      ['a/1', 1],
      ['a/2', 2],
      ['a/3', 3],
      ['a/4', 4],
    ],
  );

  await testScanResult(
    {
      limit: 1,
      prefix: 'b/',
    },
    [['b/0', 5]],
  );
});

testWithBothStores('subscribe', async () => {
  const log: [string, JSONValue][] = [];

  rep = await replicacheForTesting('subscribe');
  let queryCallCount = 0;
  const cancel = rep.subscribe(
    async (tx: ReadTransaction) => {
      queryCallCount++;
      const rv = [];
      for await (const entry of tx.scan({prefix: 'a/'}).entries()) {
        rv.push(entry);
      }
      return rv;
    },
    {
      onData: (values: Iterable<[string, JSONValue]>) => {
        for (const entry of values) {
          log.push(entry);
        }
      },
    },
  );

  expect(log).to.have.length(0);
  expect(queryCallCount).to.equal(0);

  const add = rep.register('add-data', addData);
  await add({'a/0': 0});
  expect(log).to.deep.equal([['a/0', 0]]);
  expect(queryCallCount).to.equal(2); // One for initial subscribe and one for the add.

  // The body returns the same JSON value in the following case.
  log.length = 0;
  await add({'a/0': 0});
  expect(log).to.deep.equal([]);
  expect(queryCallCount).to.equal(3);

  log.length = 0;
  await add({'a/1': 1});
  expect(log).to.deep.equal([
    ['a/0', 0],
    ['a/1', 1],
  ]);
  expect(queryCallCount).to.equal(4);

  log.length = 0;
  log.length = 0;
  await add({'a/1': 11});
  expect(log).to.deep.equal([
    ['a/0', 0],
    ['a/1', 11],
  ]);
  expect(queryCallCount).to.equal(5);

  log.length = 0;
  cancel();
  await add({'a/1': 11});
  await Promise.resolve();
  expect(log).to.have.length(0);
  expect(queryCallCount).to.equal(5);
});

testWithBothStores('subscribe close', async () => {
  rep = await replicacheForTesting('subscribe-close');

  const log: (JSONValue | undefined)[] = [];

  const cancel = rep.subscribe((tx: ReadTransaction) => tx.get('k'), {
    onData: value => log.push(value),
    onDone: () => (done = true),
  });

  expect(log).to.have.length(0);

  const add = rep.register('add-data', addData);
  await add({k: 0});
  await Promise.resolve();
  expect(log).to.deep.equal([undefined, 0]);

  let done = false;

  await rep.close();
  expect(done).to.equal(true);
  cancel();
});

testWithBothStores('name', async () => {
  const repA = await replicacheForTesting('a');
  const repB = await replicacheForTesting('b');

  const addA = repA.register('add-data', addData);
  const addB = repB.register('add-data', addData);

  await addA({key: 'A'});
  await addB({key: 'B'});

  expect(await repA.get('key')).to.equal('A');
  expect(await repB.get('key')).to.equal('B');

  await repA.close();
  await repB.close();

  indexedDB.deleteDatabase('a');
  indexedDB.deleteDatabase('b');
});

testWithBothStores('register with error', async () => {
  rep = await replicacheForTesting('regerr');

  const doErr = rep.register(
    'err',
    async (_: WriteTransaction, args: number) => {
      throw args;
    },
  );

  try {
    await doErr(42);
    fail('Should have thrown');
  } catch (ex) {
    expect(ex).to.equal(42);
  }
});

testWithBothStores('subscribe with error', async () => {
  rep = await replicacheForTesting('suberr');

  const add = rep.register('add-data', addData);

  let gottenValue = 0;
  let error;

  const cancel = rep.subscribe(
    async tx => {
      const v = await tx.get('k');
      if (v !== undefined && v !== null) {
        throw v;
      }
      return null;
    },
    {
      onData: () => {
        gottenValue++;
      },
      onError: e => {
        error = e;
      },
    },
  );
  await Promise.resolve();

  expect(error).to.equal(undefined);
  expect(gottenValue).to.equal(0);

  await add({k: 'throw'});
  expect(gottenValue).to.equal(1);
  await Promise.resolve();
  expect(error).to.equal('throw');

  cancel();
});

testWithBothStores('overlapping writes', async () => {
  async function dbWait(tx: ReadTransaction, dur: number) {
    // Try to take setTimeout away from me???
    const t0 = Date.now();
    while (Date.now() - t0 > dur) {
      await tx.get('foo');
    }
  }

  const pushURL = 'https://push.com';
  // writes wait on writes
  rep = await replicacheForTesting('conflict', {pushURL});
  fetchMock.post(pushURL, {});

  const mut = rep.register(
    'wait-then-return',
    async <T extends JSONValue>(
      tx: ReadTransaction,
      {duration, ret}: {duration: number; ret: T},
    ) => {
      await dbWait(tx, duration);
      return ret;
    },
  );

  let resA = mut({duration: 250, ret: 'a'});
  // create a gap to make sure resA starts first (our rwlock isn't fair).
  await clock.tickAsync(100);
  let resB = mut({duration: 0, ret: 'b'});
  // race them, a should complete first, indicating that b waited
  expect(await Promise.race([resA, resB])).to.equal('a');
  // wait for the other to finish so that we're starting from null state for next one.
  await Promise.all([resA, resB]);

  // reads wait on writes
  resA = mut({duration: 250, ret: 'a'});
  await clock.tickAsync(100);
  resB = rep.query(() => 'b');
  await tickAFewTimes();
  expect(await Promise.race([resA, resB])).to.equal('a');

  await tickAFewTimes();
  await resA;
  await tickAFewTimes();
  await resB;
});

testWithBothStores('push', async () => {
  const pushURL = 'https://push.com';

  rep = await replicacheForTesting('push', {
    pushAuth: '1',
    pushURL,
    pushDelay: 10,
  });

  let createCount = 0;
  let deleteCount = 0;

  const createTodo = rep.register(
    'createTodo',
    async <A extends {id: number}>(tx: WriteTransaction, args: A) => {
      createCount++;
      await tx.put(`/todo/${args.id}`, args);
    },
  );

  const deleteTodo = rep.register(
    'deleteTodo',
    async <A extends {id: number}>(tx: WriteTransaction, args: A) => {
      deleteCount++;
      await tx.del(`/todo/${args.id}`);
    },
  );

  const id1 = 14323534;
  const id2 = 22354345;

  await deleteTodo({id: id1});
  await deleteTodo({id: id2});

  expect(deleteCount).to.equal(2);

  fetchMock.postOnce(pushURL, {
    mutationInfos: [
      {id: 1, error: 'deleteTodo: todo not found'},
      {id: 2, error: 'deleteTodo: todo not found'},
    ],
  });
  await tickAFewTimes();
  expect(deleteCount).to.equal(2);
  const {mutations} = await fetchMock.lastCall().request.json();
  expect(mutations).to.deep.equal([
    {id: 1, name: 'deleteTodo', args: {id: id1}},
    {id: 2, name: 'deleteTodo', args: {id: id2}},
  ]);

  await createTodo({
    id: id1,
    text: 'Test',
  });
  expect(createCount).to.equal(1);
  expect(((await rep?.get(`/todo/${id1}`)) as {text: string}).text).to.equal(
    'Test',
  );

  fetchMock.postOnce(pushURL, {
    mutationInfos: [{id: 3, error: 'mutation has already been processed'}],
  });
  await tickAFewTimes();
  {
    const {mutations} = await fetchMock.lastCall().request.json();
    expect(mutations).to.deep.equal([
      {id: 1, name: 'deleteTodo', args: {id: id1}},
      {id: 2, name: 'deleteTodo', args: {id: id2}},
      {id: 3, name: 'createTodo', args: {id: id1, text: 'Test'}},
    ]);
  }

  await createTodo({
    id: id2,
    text: 'Test 2',
  });
  expect(createCount).to.equal(2);
  expect(((await rep?.get(`/todo/${id2}`)) as {text: string}).text).to.equal(
    'Test 2',
  );

  // Clean up
  await deleteTodo({id: id1});
  await deleteTodo({id: id2});

  expect(deleteCount).to.equal(4);
  expect(createCount).to.equal(2);

  fetchMock.postOnce(pushURL, {
    mutationInfos: [],
  });
  await tickAFewTimes();
  {
    const {mutations} = await fetchMock.lastCall().request.json();
    expect(mutations).to.deep.equal([
      {id: 1, name: 'deleteTodo', args: {id: id1}},
      {id: 2, name: 'deleteTodo', args: {id: id2}},
      {id: 3, name: 'createTodo', args: {id: id1, text: 'Test'}},
      {id: 4, name: 'createTodo', args: {id: id2, text: 'Test 2'}},
      {id: 5, name: 'deleteTodo', args: {id: id1}},
      {id: 6, name: 'deleteTodo', args: {id: id2}},
    ]);
  }

  expect(deleteCount).to.equal(4);
  expect(createCount).to.equal(2);
});

testWithBothStores('push delay', async () => {
  const pushURL = 'https://push.com';

  rep = await replicacheForTesting('push', {
    pushAuth: '1',
    pushURL,
    pushDelay: 1,
  });

  const createTodo = rep.register(
    'createTodo',
    async <A extends {id: number}>(tx: WriteTransaction, args: A) => {
      await tx.put(`/todo/${args.id}`, args);
    },
  );

  const id1 = 14323534;

  await tickAFewTimes();
  fetchMock.reset();

  fetchMock.postOnce(pushURL, {
    mutationInfos: [],
  });

  expect(fetchMock.calls()).to.have.length(0);

  await createTodo({id: id1});

  expect(fetchMock.calls()).to.have.length(0);

  await tickAFewTimes();

  expect(fetchMock.calls()).to.have.length(1);
});

testWithBothStores('pull', async () => {
  const pullURL = 'https://diff.com/pull';

  rep = await replicacheForTesting('pull', {
    pullAuth: '1',
    pullURL,
  });

  let createCount = 0;
  let deleteCount = 0;
  let syncHead: string;
  let beginPullResult: {
    requestID: string;
    syncHead: string;
    ok: boolean;
  };

  const createTodo = rep.register(
    'createTodo',
    async <A extends {id: number}>(tx: WriteTransaction, args: A) => {
      createCount++;
      await tx.put(`/todo/${args.id}`, args);
    },
  );

  const deleteTodo = rep.register(
    'deleteTodo',
    async <A extends {id: number}>(tx: WriteTransaction, args: A) => {
      deleteCount++;
      await tx.del(`/todo/${args.id}`);
    },
  );

  const id1 = 14323534;
  const id2 = 22354345;

  await deleteTodo({id: id1});
  await deleteTodo({id: id2});

  expect(deleteCount).to.equal(2);

  fetchMock.postOnce(pullURL, {
    cookie: '',
    lastMutationID: 2,
    patch: [
      {op: 'del', key: ''},
      {
        op: 'put',
        key: '/list/1',
        value: {id: 1, ownerUserID: 1},
      },
    ],
  });
  rep.pull();
  await tickAFewTimes();
  expect(deleteCount).to.equal(2);

  fetchMock.postOnce(pullURL, {
    cookie: '',
    lastMutationID: 2,
    patch: [],
  });
  beginPullResult = await rep.beginPull();
  ({syncHead} = beginPullResult);
  expect(syncHead).to.equal(emptyHash);
  expect(deleteCount).to.equal(2);

  await createTodo({
    id: id1,
    text: 'Test',
  });
  expect(createCount).to.equal(1);
  expect(((await rep?.get(`/todo/${id1}`)) as {text: string}).text).to.equal(
    'Test',
  );

  fetchMock.postOnce(pullURL, {
    cookie: '',
    lastMutationID: 3,
    patch: [
      {
        op: 'put',
        key: '/todo/14323534',
        value: {id: 14323534, text: 'Test'},
      },
    ],
  });
  beginPullResult = await rep.beginPull();
  ({syncHead} = beginPullResult);
  expect(syncHead).equal('vadlsm00t0h5n05204h6srdjama32lft');

  await createTodo({
    id: id2,
    text: 'Test 2',
  });
  expect(createCount).to.equal(2);
  expect(((await rep?.get(`/todo/${id2}`)) as {text: string}).text).to.equal(
    'Test 2',
  );

  fetchMock.postOnce(pullURL, {
    cookie: '',
    lastMutationID: 3,
    patch: [],
  });
  await rep.maybeEndPull(beginPullResult);

  expect(createCount).to.equal(3);

  // Clean up
  await deleteTodo({id: id1});
  await deleteTodo({id: id2});

  expect(deleteCount).to.equal(4);
  expect(createCount).to.equal(3);

  fetchMock.postOnce(pullURL, {
    cookie: '',
    lastMutationID: 6,
    patch: [{op: 'del', key: '/todo/14323534'}],
  });
  rep.pull();
  await tickAFewTimes();

  expect(deleteCount).to.equal(4);
  expect(createCount).to.equal(3);
});

testWithBothStores('reauth', async () => {
  const pullURL = 'https://diff.com/pull';

  rep = await replicacheForTesting('reauth', {
    pullURL,
    pullAuth: 'wrong',
  });

  fetchMock.post(pullURL, {body: 'xxx', status: httpStatusUnauthorized});

  const consoleErrorStub = sinon.stub(console, 'error');

  const getPullAuthFake = sinon.fake.returns(null);
  rep.getPullAuth = getPullAuthFake;

  await rep.beginPull();

  expect(getPullAuthFake.callCount).to.equal(1);
  expect(consoleErrorStub.firstCall.args[0]).to.equal(
    'Got error response from server (https://diff.com/pull) doing pull: 401: xxx',
  );

  {
    const consoleInfoStub = sinon.stub(console, 'log');
    const getPullAuthFake = sinon.fake(() => 'boo');
    rep.getPullAuth = getPullAuthFake;

    expect((await rep.beginPull()).syncHead).to.equal('');

    expect(getPullAuthFake.callCount).to.equal(8);
    expect(consoleInfoStub.firstCall.args[0]).to.equal(
      'Tried to reauthenticate too many times',
    );
  }
});

testWithBothStores('HTTP status pull', async () => {
  const pullURL = 'https://diff.com/pull';

  rep = await replicacheForTesting('http-status-pull', {
    pullURL,
  });

  let okCalled = false;
  let i = 0;
  fetchMock.post(pullURL, () => {
    switch (i++) {
      case 0:
        return {body: 'internal error', status: 500};
      case 1:
        return {body: 'not found', status: 404};
      default:
        okCalled = true;
        return {body: {lastMutationID: 0, patch: []}, status: 200};
    }
  });

  const consoleErrorStub = sinon.stub(console, 'error');

  rep.pull();

  await tickAFewTimes(20, 10);

  expect(consoleErrorStub.getCalls().map(o => o.args[0])).to.deep.equal([
    'Got error response from server (https://diff.com/pull) doing pull: 500: internal error',
    'Got error response from server (https://diff.com/pull) doing pull: 404: not found',
  ]);

  expect(okCalled).to.equal(true);
});

testWithBothStores('HTTP status push', async () => {
  const pushURL = 'https://diff.com/push';

  rep = await replicacheForTesting('http-status-push', {
    pushURL,
    pushDelay: 1,
  });
  const add = rep.register('add-data', addData);

  let okCalled = false;
  let i = 0;
  fetchMock.post(pushURL, () => {
    switch (i++) {
      case 0:
        return {body: 'internal error', status: 500};
      case 1:
        return {body: 'not found', status: 404};
      default:
        okCalled = true;
        return {body: {}, status: 200};
    }
  });

  const consoleErrorStub = sinon.stub(console, 'error');

  await add({
    a: 0,
  });

  await tickAFewTimes(20, 10);

  expect(consoleErrorStub.getCalls().map(o => o.args[0])).to.deep.equal([
    'Got error response from server (https://diff.com/push) doing push: 500: internal error',
    'Got error response from server (https://diff.com/push) doing push: 404: not found',
  ]);

  expect(okCalled).to.equal(true);
});

testWithBothStores('closed tx', async () => {
  rep = await replicacheForTesting('reauth');

  let rtx: ReadTransaction;
  await rep.query(tx => (rtx = tx));

  await expectAsyncFuncToThrow(() => rtx.get('x'), TransactionClosedError);
  await expectAsyncFuncToThrow(() => rtx.has('y'), TransactionClosedError);
  await expectAsyncFuncToThrow(
    () => rtx.scan().values().next(),
    TransactionClosedError,
  );

  let wtx: WriteTransaction | undefined;
  const mut = rep.register('mut', async tx => {
    wtx = tx;
  });

  await mut();
  expect(wtx).to.not.be.undefined;
  await expectAsyncFuncToThrow(() => wtx?.put('z', 1), TransactionClosedError);
  await expectAsyncFuncToThrow(() => wtx?.del('w'), TransactionClosedError);
});

testWithBothStores('pullInterval in constructor', async () => {
  const rep = new Replicache({
    pullInterval: 12.34,
  });
  expect(rep.pullInterval).to.equal(12.34);
  await rep.close();
});

testWithBothStores('closeTransaction after rep.scan', async () => {
  rep = await replicacheForTesting('test5');
  const add = rep.register('add-data', addData);
  await add({
    'a/0': 0,
    'a/1': 1,
  });

  const spy = spyInvoke(rep);
  spy.resetHistory();

  function expectCalls(l: JSONValue[]) {
    expect(l).to.deep.equal(log);
    const rpcs = spy.args.map(([rpc]) => rpc);
    expect(rpcs).to.deep.equal([
      RPC.OpenTransaction,
      RPC.Scan,
      RPC.CloseTransaction,
    ]);
  }

  const it = rep.scan();
  const log: JSONValue[] = [];
  for await (const v of it) {
    log.push(v);
  }
  expectCalls([0, 1]);

  // One more time with return in loop...
  log.length = 0;
  spy.resetHistory();
  await (async () => {
    if (!rep) {
      fail();
    }
    const it = rep.scan();
    for await (const v of it) {
      log.push(v);
      return;
    }
  })();
  expectCalls([0]);

  // ... and with a break.
  log.length = 0;
  spy.resetHistory();
  {
    const it = rep.scan();
    for await (const v of it) {
      log.push(v);
      break;
    }
  }
  expectCalls([0]);

  // ... and with a throw.
  log.length = 0;
  spy.resetHistory();
  (
    await expectPromiseToReject(
      (async () => {
        if (!rep) {
          fail();
        }
        const it = rep.scan();
        for await (const v of it) {
          log.push(v);
          throw 'hi!';
        }
      })(),
    )
  ).to.equal('hi!');

  expectCalls([0]);

  // ... and with a throw.
  log.length = 0;
  spy.resetHistory();
  (
    await expectPromiseToReject(
      (async () => {
        if (!rep) {
          fail();
        }
        const it = rep.scan();
        for await (const v of it) {
          log.push(v);
          throw 'hi!';
        }
      })(),
    )
  ).to.equal('hi!');
  expectCalls([0]);
});

testWithBothStores('index', async () => {
  rep = await replicacheForTesting('test-index');

  const add = rep.register('add-data', addData);
  await add({
    'a/0': {a: '0'},
    'a/1': {a: '1'},
    'a/2': {a: '2'},
    'a/3': {a: '3'},
    'a/4': {a: '4'},
    'b/0': {bc: '5'},
    'b/1': {bc: '6'},
    'b/2': {bc: '7'},
    'c/0': {bc: '8'},
    'd/0': {d: {e: {f: '9'}}},
  });
  await rep.createIndex({name: 'aIndex', jsonPointer: '/a'});

  await testScanResult({indexName: 'aIndex'}, [
    [['0', 'a/0'], {a: '0'}],
    [['1', 'a/1'], {a: '1'}],
    [['2', 'a/2'], {a: '2'}],
    [['3', 'a/3'], {a: '3'}],
    [['4', 'a/4'], {a: '4'}],
  ]);
  await rep.dropIndex('aIndex');
  await expectPromiseToReject(rep.scanAll({indexName: 'aIndex'}));

  await rep.createIndex({name: 'aIndex', jsonPointer: '/a'});
  await testScanResult({indexName: 'aIndex'}, [
    [['0', 'a/0'], {a: '0'}],
    [['1', 'a/1'], {a: '1'}],
    [['2', 'a/2'], {a: '2'}],
    [['3', 'a/3'], {a: '3'}],
    [['4', 'a/4'], {a: '4'}],
  ]);
  await rep.dropIndex('aIndex');
  await expectPromiseToReject(rep.scanAll({indexName: 'aIndex'}));

  await rep.createIndex({name: 'bc', keyPrefix: 'c/', jsonPointer: '/bc'});
  await testScanResult({indexName: 'bc'}, [[['8', 'c/0'], {bc: '8'}]]);
  await add({
    'c/1': {bc: '88'},
  });
  await testScanResult({indexName: 'bc'}, [
    [['8', 'c/0'], {bc: '8'}],
    [['88', 'c/1'], {bc: '88'}],
  ]);
  await rep.dropIndex('bc');

  await rep.createIndex({name: 'dIndex', jsonPointer: '/d/e/f'});
  await testScanResult({indexName: 'dIndex'}, [
    [['9', 'd/0'], {d: {e: {f: '9'}}}],
  ]);
  await rep.dropIndex('dIndex');

  await add({
    'e/0': {'': ''},
  });
  await rep.createIndex({name: 'emptyKeyIndex', jsonPointer: '/'});
  await testScanResult({indexName: 'emptyKeyIndex'}, [[['', 'e/0'], {'': ''}]]);
  await rep.dropIndex('emptyKeyIndex');
});

testWithBothStores('index array', async () => {
  rep = await replicacheForTesting('test-index');

  const add = rep.register('add-data', addData);
  await add({
    'a/0': {a: []},
    'a/1': {a: ['0']},
    'a/2': {a: ['1', '2']},
    'a/3': {a: '3'},
    'a/4': {a: ['4']},
    'b/0': {bc: '5'},
    'b/1': {bc: '6'},
    'b/2': {bc: '7'},
    'c/0': {bc: '8'},
  });

  await rep.createIndex({name: 'aIndex', jsonPointer: '/a'});
  await testScanResult({indexName: 'aIndex'}, [
    [['0', 'a/1'], {a: ['0']}],
    [['1', 'a/2'], {a: ['1', '2']}],
    [['2', 'a/2'], {a: ['1', '2']}],
    [['3', 'a/3'], {a: '3'}],
    [['4', 'a/4'], {a: ['4']}],
  ]);
  await rep.dropIndex('aIndex');
});

testWithBothStores('index scan start', async () => {
  rep = await replicacheForTesting('test-index-scan');

  const add = rep.register('add-data', addData);
  await add({
    'a/1': {a: '0'},
    'b/0': {b: 'a5'},
    'b/1': {b: 'a6'},
    'b/2': {b: 'b7'},
    'b/3': {b: 'b8'},
  });

  await rep.createIndex({
    name: 'bIndex',
    jsonPointer: '/b',
  });

  for (const key of ['a6', ['a6'], ['a6', undefined], ['a6', '']] as (
    | string
    | [string, string?]
  )[]) {
    await testScanResult({indexName: 'bIndex', start: {key}}, [
      [['a6', 'b/1'], {b: 'a6'}],
      [['b7', 'b/2'], {b: 'b7'}],
      [['b8', 'b/3'], {b: 'b8'}],
    ]);
    await testScanResult(
      {indexName: 'bIndex', start: {key, exclusive: false}},
      [
        [['a6', 'b/1'], {b: 'a6'}],
        [['b7', 'b/2'], {b: 'b7'}],
        [['b8', 'b/3'], {b: 'b8'}],
      ],
    );
  }

  for (const key of ['a6', ['a6'], ['a6', undefined]] as (
    | string
    | [string, string?]
  )[]) {
    await testScanResult(
      {indexName: 'bIndex', start: {key, exclusive: false}},
      [
        [['a6', 'b/1'], {b: 'a6'}],
        [['b7', 'b/2'], {b: 'b7'}],
        [['b8', 'b/3'], {b: 'b8'}],
      ],
    );
    await testScanResult(
      {indexName: 'bIndex', start: {key: ['a6', ''], exclusive: true}},
      [
        [['a6', 'b/1'], {b: 'a6'}],
        [['b7', 'b/2'], {b: 'b7'}],
        [['b8', 'b/3'], {b: 'b8'}],
      ],
    );
  }

  for (const key of ['a6', ['a6'], ['a6', undefined]] as (
    | string
    | [string, string?]
  )[]) {
    await testScanResult({indexName: 'bIndex', start: {key, exclusive: true}}, [
      [['b7', 'b/2'], {b: 'b7'}],
      [['b8', 'b/3'], {b: 'b8'}],
    ]);
  }

  await testScanResult({indexName: 'bIndex', start: {key: ['b7', 'b/2']}}, [
    [['b7', 'b/2'], {b: 'b7'}],
    [['b8', 'b/3'], {b: 'b8'}],
  ]);
  await testScanResult(
    {indexName: 'bIndex', start: {key: ['b7', 'b/2'], exclusive: false}},
    [
      [['b7', 'b/2'], {b: 'b7'}],
      [['b8', 'b/3'], {b: 'b8'}],
    ],
  );
  await testScanResult(
    {indexName: 'bIndex', start: {key: ['b7', 'b/2'], exclusive: true}},
    [[['b8', 'b/3'], {b: 'b8'}]],
  );

  await testScanResult({indexName: 'bIndex', start: {key: ['a6', 'b/2']}}, [
    [['b7', 'b/2'], {b: 'b7'}],
    [['b8', 'b/3'], {b: 'b8'}],
  ]);
  await testScanResult(
    {indexName: 'bIndex', start: {key: ['a6', 'b/2'], exclusive: false}},
    [
      [['b7', 'b/2'], {b: 'b7'}],
      [['b8', 'b/3'], {b: 'b8'}],
    ],
  );
  await testScanResult(
    {indexName: 'bIndex', start: {key: ['a6', 'b/2'], exclusive: true}},
    [
      [['b7', 'b/2'], {b: 'b7'}],
      [['b8', 'b/3'], {b: 'b8'}],
    ],
  );

  await rep.dropIndex('bIndex');
});

// Only used for type checking
test.skip('mutator optional args [type checking only]', async () => {
  rep = await replicacheForTesting('test-types');

  const mut = rep.register('mut', async (tx: WriteTransaction, x: number) => {
    console.log(tx);
    return x;
  });
  const res: number = await mut(42);
  console.log(res);

  const mut2 = rep.register('mut', (tx: WriteTransaction, x: string) => {
    console.log(tx);
    return x;
  });
  const res2: string = await mut2('s');
  console.log(res2);

  const mut3 = rep.register('mut2', tx => {
    console.log(tx);
  });
  await mut3();
  //  @ts-expect-error: Expected 0 arguments, but got 1.ts(2554)
  await mut3(42);
  //  @ts-expect-error: Type 'void' is not assignable to type 'number'.ts(2322)
  const res3: number = await mut3();
  console.log(res3);

  const mut4 = rep.register('mut2', async tx => {
    console.log(tx);
  });
  await mut4();
  //  @ts-expect-error: Expected 0 arguments, but got 1.ts(2554)
  await mut4(42);
  //  @ts-expect-error: Type 'void' is not assignable to type 'number'.ts(2322)
  const res4: number = await mut4();
  console.log(res4);

  // @ts-expect-error: Types of parameters 'x' and 'args' are incompatible.
  //   Type 'JSONValue' is not assignable to type 'Date'.
  //     Type 'null' is not assignable to type 'Date'.ts(2769)
  const mut5 = rep.register('mut3', (tx: WriteTransaction, x: Date) => {
    console.log(tx);
    return x;
  });
  console.log(mut5);
});

testWithBothStores('logLevel', async () => {
  const info = sinon.stub(console, 'log');
  const debug = sinon.stub(console, 'debug');

  // Just testing that we get some output
  rep = await replicacheForTesting('log-level', {logLevel: 'error'});
  await rep.query(() => 42);
  expect(info.callCount).to.equal(0);
  await rep.close();

  info.reset();
  debug.reset();
  await tickAFewTimes(10, 100);

  rep = await replicacheForTesting('log-level', {logLevel: 'info'});
  await rep.query(() => 42);
  expect(info.callCount).to.equal(0);
  expect(debug.callCount).to.equal(0);
  await rep.close();

  info.reset();
  debug.reset();
  await tickAFewTimes(10, 100);

  rep = await replicacheForTesting('log-level', {logLevel: 'debug'});
  await rep.query(() => 42);
  expect(info.callCount).to.be.greaterThan(0);
  expect(debug.callCount).to.be.greaterThan(0);

  expect(
    info.getCalls().some(call => call.firstArg.includes('OpenTransaction')),
  ).to.equal(true);
  expect(
    debug.getCalls().some(call => call.firstArg.includes('PULL')),
  ).to.equal(true);
  expect(
    debug.getCalls().some(call => call.firstArg.includes('PUSH')),
  ).to.equal(true);

  await rep.close();

  // Restoring since we are not yet scoped to a Replicache db instance.
  rep = await replicacheForTesting('log-level', {logLevel: 'info'});
});

test('JSON deep equal', () => {
  const t = (
    a: JSONValue | undefined,
    b: JSONValue | undefined,
    expected = true,
  ) => {
    const res = deepEqual(a, b);
    if (res !== expected) {
      fail(
        JSON.stringify(a) + (expected ? ' === ' : ' !== ') + JSON.stringify(b),
      );
    }
  };

  const oneLevelOfData = [
    0,
    1,
    2,
    3,
    456789,
    true,
    false,
    null,
    '',
    'a',
    'b',
    'cdefefsfsafasdadsaas',
    [],
    {},
    {x: 4, y: 5, z: 6},
    [7, 8, 9],
  ] as const;

  const testData = [
    ...oneLevelOfData,
    [...oneLevelOfData],
    Object.fromEntries(oneLevelOfData.map(v => [JSON.stringify(v), v])),
  ];

  for (let i = 0; i < testData.length; i++) {
    for (let j = 0; j < testData.length; j++) {
      const a = testData[i];
      // "clone" to ensure we do not end up with a and b being the same object.
      const b = JSON.parse(JSON.stringify(testData[j]));
      t(a, b, i === j);
    }
  }

  t({a: 1, b: 2}, {b: 2, a: 1});
});

// Only used for type checking
test.skip('Test partial JSONObject [type checking only]', async () => {
  rep = await replicacheForTesting('test-types');

  type Todo = {id: number; text: string};

  const mut = rep.register(
    'mut',
    async (tx: WriteTransaction, todo: Partial<Todo>) => {
      console.log(tx);
      return todo;
    },
  );
  await mut({});
  await mut({id: 42});
  await mut({text: 'abc'});

  // @ts-expect-error Type '42' has no properties in common with type 'Partial<Todo>'.ts(2559)
  await mut(42);
  // @ts-expect-error Type 'string' is not assignable to type 'number | undefined'.ts(2322)
  await mut({id: 'abc'});
});

// Only used for type checking
test.skip('Test register param [type checking only]', async () => {
  rep = await replicacheForTesting('test-types');

  const mut: () => Promise<void> = rep.register(
    'mut',
    async (tx: WriteTransaction) => {
      console.log(tx);
    },
  );
  console.log(mut);

  // @ts-expect-error Type 'number' is not assignable to type 'string'.ts(2322)
  const mut2: (x: number) => Promise<void> = rep.register(
    'mut2',
    async (tx: WriteTransaction, x: string) => {
      console.log(tx, x);
    },
  );
  console.log(mut2);

  // @ts-expect-error Type '(args: string) => Promise<void>' is not assignable to type '() => Promise<void>'.ts(2322)
  const mut3: () => Promise<void> = rep.register(
    'mut3',
    async (tx: WriteTransaction, x: string) => {
      console.log(tx, x);
    },
  );
  console.log(mut3);

  // This is fine according to the rules of JS/TS
  const mut4: (x: number) => Promise<void> = rep.register(
    'mut4',
    async (tx: WriteTransaction) => {
      console.log(tx);
    },
  );
  console.log(mut4);

  rep.register(
    'mut5',
    // @ts-expect-error ts(2345)
    async (tx: WriteTransaction, a: string, b: number) => {
      console.log(tx, a, b);
    },
  );
});

// Only used for type checking
test.skip('Key type for scans [type checking only]', async () => {
  rep = await replicacheForTesting('test-types');

  for await (const k of rep.scan({indexName: 'n'}).keys()) {
    // @ts-expect-error Type '[secondary: string, primary?: string | undefined]' is not assignable to type 'string'.ts(2322)
    const k2: string = k;
    console.log(k2);
  }

  for await (const k of rep.scan({indexName: 'n', start: {key: 's'}}).keys()) {
    // @ts-expect-error Type '[secondary: string, primary?: string | undefined]' is not assignable to type 'string'.ts(2322)
    const k2: string = k;
    console.log(k2);
  }

  for await (const k of rep
    .scan({indexName: 'n', start: {key: ['s']}})
    .keys()) {
    // @ts-expect-error Type '[secondary: string, primary?: string | undefined]' is not assignable to type 'string'.ts(2322)
    const k2: string = k;
    console.log(k2);
  }

  for await (const k of rep.scan({start: {key: 'p'}}).keys()) {
    // @ts-expect-error Type 'string' is not assignable to type '[string]'.ts(2322)
    const k2: [string] = k;
    console.log(k2);
  }

  // @ts-expect-error Type 'number' is not assignable to type 'string | undefined'.ts(2322)
  rep.scan({indexName: 'n', start: {key: ['s', 42]}});

  // @ts-expect-error Type 'number' is not assignable to type 'string | undefined'.ts(2322)
  rep.scanAll({indexName: 'n', start: {key: ['s', 42]}});

  // @ts-expect-error Type '[string]' is not assignable to type 'string'.ts(2322)
  rep.scan({start: {key: ['s']}});

  // @ts-expect-error Type '[string]' is not assignable to type 'string'.ts(2322)
  rep.scanAll({start: {key: ['s']}});
});

test('mem store', async () => {
  rep = await replicacheForTesting('mem', {useMemstore: true});
  const add = rep.register('addData', addData);
  await add({a: 42});
  expect(await rep.query(tx => tx.get('a'))).to.equal(42);
  await rep.close();
  rep = null;

  // Open again and test that we lost the data
  rep = await replicacheForTesting('mem', {useMemstore: true});
  expect(await rep.query(tx => tx.get('a'))).to.equal(undefined);
});

testWithBothStores('isEmpty', async () => {
  rep = await replicacheForTesting('test-is-empty');
  const add = rep.register('add-data', addData);
  const del = rep.register('del', (tx: WriteTransaction, key: string) =>
    tx.del(key),
  );

  async function t(expected: boolean) {
    expect(await rep?.query(tx => tx.isEmpty())).to.eq(expected);
    expect(await rep?.isEmpty()).to.eq(expected);
  }

  await t(true);

  await add({a: 1});
  await t(false);

  await add({b: 2, c: 3});
  await t(false);

  await del('b');
  await t(false);

  const mut = rep.register('mut', async tx => {
    expect(await tx.isEmpty()).to.eq(false);

    tx.del('c');
    expect(await tx.isEmpty()).to.eq(false);

    tx.del('a');
    expect(await tx.isEmpty()).to.eq(true);

    tx.put('d', 4);
    expect(await tx.isEmpty()).to.eq(false);
  });
  await mut();

  await t(false);
});

testWithBothStores('onSync', async () => {
  const pullURL = 'https://pull.com/pull';
  const pushURL = 'https://push.com/push';

  rep = await replicacheForTesting('onSync', {pullURL, pushURL, pushDelay: 5});
  const add = rep.register('add-data', addData);

  const onSync = sinon.fake();
  rep.onSync = onSync;

  expect(onSync.callCount).to.eq(0);

  fetchMock.postOnce(pullURL, {
    cookie: '',
    lastMutationID: 2,
    patch: [],
  });
  rep.pull();
  await tickAFewTimes(15);

  expect(onSync.callCount).to.eq(2);
  expect(onSync.getCall(0).args[0]).to.be.true;
  expect(onSync.getCall(1).args[0]).to.be.false;

  onSync.resetHistory();
  fetchMock.postOnce(pushURL, {});
  await add({a: 'a'});
  await tickAFewTimes();

  expect(onSync.callCount).to.eq(2);
  expect(onSync.getCall(0).args[0]).to.be.true;
  expect(onSync.getCall(1).args[0]).to.be.false;

  fetchMock.postOnce(pushURL, {});
  onSync.resetHistory();
  await add({b: 'b'});
  await tickAFewTimes();
  expect(onSync.callCount).to.eq(2);
  expect(onSync.getCall(0).args[0]).to.be.true;
  expect(onSync.getCall(1).args[0]).to.be.false;

  {
    // Try with reauth
    const consoleErrorStub = sinon.stub(console, 'error');
    fetchMock.postOnce(pushURL, {body: 'xxx', status: httpStatusUnauthorized});
    onSync.resetHistory();
    rep.getPushAuth = () => {
      // Next time it is going to be fine
      fetchMock.postOnce({url: pushURL, headers: {authorization: 'ok'}}, {});
      return 'ok';
    };

    await add({c: 'c'});
    await tickAFewTimes(6);

    expect(consoleErrorStub.firstCall.args[0]).to.equal(
      'Got error response from server (https://push.com/push) doing push: 401: xxx',
    );

    expect(onSync.callCount).to.eq(4);
    expect(onSync.getCall(0).args[0]).to.be.true;
    expect(onSync.getCall(1).args[0]).to.be.false;
    expect(onSync.getCall(2).args[0]).to.be.true;
    expect(onSync.getCall(3).args[0]).to.be.false;
  }

  rep.onSync = null;
  onSync.resetHistory();
  fetchMock.postOnce(pushURL, {});
  expect(onSync.callCount).to.eq(0);
});

testWithBothStores('push timing', async () => {
  const pushURL = 'https://push.com/push';
  const pushDelay = 5;

  rep = await replicacheForTesting('push-timing', {
    pushURL,
    pushDelay,
    useMemstore: true,
  });
  const spy = spyInvoke(rep);

  const add = rep.register('add-data', addData);

  fetchMock.post(pushURL, {});
  await add({a: 0});
  await tickAFewTimes();

  const tryPushCalls = () =>
    spy.args.filter(([rpc]) => rpc === RPC.TryPush).length;

  expect(tryPushCalls()).to.eq(1);

  spy.resetHistory();

  // This will schedule push in pushDelay ms
  await add({a: 1});
  await add({b: 2});
  await add({c: 3});
  await add({d: 4});

  expect(tryPushCalls()).to.eq(0);

  await clock.tickAsync(pushDelay + 10);

  expect(tryPushCalls()).to.eq(1);
  spy.resetHistory();

  const p1 = add({e: 5});
  const p2 = add({f: 6});
  const p3 = add({g: 7});

  expect(tryPushCalls()).to.eq(0);

  await tickAFewTimes();
  await p1;
  expect(tryPushCalls()).to.eq(1);
  await tickAFewTimes();
  await p2;
  expect(tryPushCalls()).to.eq(1);
  await tickAFewTimes();
  await p3;
  expect(tryPushCalls()).to.eq(1);
});

test('push and pull concurrently', async () => {
  const pushURL = 'https://push.com/push';
  const pullURL = 'https://pull.com/pull';

  rep = await replicacheForTesting('concurrently', {
    pullURL,
    pushURL,
    useMemstore: true,
    pushDelay: 10,
  });
  const spy = spyInvoke(rep);

  const add = rep.register('add-data', addData);

  const reqs: string[] = [];

  fetchMock.post(pushURL, async () => {
    reqs.push(pushURL);
    return {};
  });
  fetchMock.post(pullURL, () => {
    reqs.push(pullURL);
    return {lastMutationID: 0, patch: []};
  });

  await add({a: 0});
  spy.resetHistory();

  await add({b: 1});
  const pullP1 = rep.pull();

  await clock.tickAsync(10);

  const rpcs = () => spy.args.map(a => a[0]);

  // Only one push at a time but we want push and pull to be concurrent.
  expect(rpcs().map(x => RPC[x])).to.deep.equal([
    'OpenTransaction',
    'Put',
    'CommitTransaction',
    'OpenTransaction',
    'CloseTransaction',
    'BeginTryPull',
    'TryPush',
  ]);

  await tickAFewTimes();

  expect(reqs).to.deep.equal([pullURL, pushURL]);

  await tickAFewTimes();
  await pullP1;

  expect(reqs).to.deep.equal([pullURL, pushURL]);

  expect(rpcs().map(x => RPC[x])).to.deep.equal([
    'OpenTransaction',
    'Put',
    'CommitTransaction',
    'OpenTransaction',
    'CloseTransaction',
    'BeginTryPull',
    'TryPush',
  ]);
});

test('schemaVersion pull', async () => {
  const schemaVersion = 'testing-pull';

  rep = await replicacheForTesting('schema-version-pull', {
    schemaVersion,
  });

  rep.pull();
  await tickAFewTimes();

  const req = await fetchMock.lastCall().request.json();
  expect(req.schemaVersion).to.deep.equal(schemaVersion);
});

test('schemaVersion push', async () => {
  const pushURL = 'https://push.com/push';
  const schemaVersion = 'testing-push';

  rep = await replicacheForTesting('schema-version-push', {
    pushURL,
    schemaVersion,
    pushDelay: 1,
  });

  const add = rep.register('add-data', addData);
  await add({a: 1});

  fetchMock.post(pushURL, {});
  await tickAFewTimes();

  const req = await fetchMock.lastCall().request.json();
  expect(req.schemaVersion).to.deep.equal(schemaVersion);
});

test('clientID', async () => {
  const re = /^[0-9:A-z]{8}-[0-9:A-z]{4}-4[0-9:A-z]{3}-[0-9:A-z]{4}-[0-9:A-z]{12}$/;

  rep = await replicacheForTesting('clientID');
  const clientID = await rep.clientID;
  expect(clientID).to.match(re);
  await rep.close();

  rep2 = await replicacheForTesting('clientID2');
  const clientID2 = await rep2.clientID;
  expect(clientID2).to.match(re);
  expect(clientID2).to.not.equal(clientID);

  rep = await replicacheForTesting('clientID');
  const clientID3 = await rep.clientID;
  expect(clientID3).to.match(re);
  expect(clientID3).to.equal(clientID);
});
