// Setup's "Mileage and allowances": the rate per km and per day that price a
// claim with no receipt, and the account each is coded to. A rate prices
// money, so unlike the free-text defaults it is checked before it is kept.
const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const jwt     = require('jsonwebtoken');

describe('routes/setup — mileage and allowances', () => {
  let app, users, jwtSecret, user;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    app = express();
    app.use(express.json());
    app.use('/api/setup', require('./setup'));
    user = await users.createUser(`set${Date.now()}${Math.random().toString(36).slice(2, 6)}@test.com`, 'password123', 'user');
  });

  const auth = () => `Bearer ${jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret())}`;
  const save = body => request(serverFor(app)).post('/api/setup').set('Authorization', auth()).send(body);
  const load = () => request(serverFor(app)).get('/api/setup').set('Authorization', auth()).expect(200).then(r => r.body);

  test('is its own section, empty (off) by default, with plain labels', async () => {
    const body = await load();
    expect(Object.keys(body.allowances)).toEqual(['MILEAGE_RATE', 'MILEAGE_ACCOUNT_CODE', 'PER_DIEM_RATE', 'PER_DIEM_ACCOUNT_CODE']);
    expect(body.allowances.MILEAGE_RATE).toMatchObject({ value: '', isSet: false, label: 'Mileage rate per km' });
    expect(body.allowances.PER_DIEM_RATE).toMatchObject({ value: '', isSet: false, label: 'Per diem daily rate' });
    expect(users.getAllowanceSettings(user.id)).toMatchObject({ mileage: { rate: null }, per_diem: { rate: null } });
  });

  test('a blank account says it uses the claim account, which follows the default account', async () => {
    expect((await load()).allowances.MILEAGE_ACCOUNT_CODE.hint).toBe('Blank uses your claim account (429).');
    await save({ DEFAULT_ACCOUNT_CODE: '420' }).expect(200);
    const body = await load();
    expect(body.allowances.PER_DIEM_ACCOUNT_CODE.hint).toBe('Blank uses your claim account (420).');
    expect(users.getAllowanceSettings(user.id)).toMatchObject({ mileage: { accountCode: '420' }, per_diem: { accountCode: '420' } });
  });

  test('valid rates and accounts are stored per user, normalised', async () => {
    await save({ MILEAGE_RATE: ' 0.6 ', PER_DIEM_RATE: '80', MILEAGE_ACCOUNT_CODE: '493', PER_DIEM_ACCOUNT_CODE: 'TRAVEL-1' }).expect(200);
    const config = users.getUserConfig(user.id);
    expect(config).toMatchObject({ MILEAGE_RATE: '0.60', PER_DIEM_RATE: '80.00', MILEAGE_ACCOUNT_CODE: '493', PER_DIEM_ACCOUNT_CODE: 'TRAVEL-1' });
    expect((await load()).allowances.MILEAGE_RATE).toMatchObject({ value: '0.60', isSet: true });
    expect(users.getAllowanceSettings(user.id)).toEqual({
      currency: 'SGD',
      mileage:  { rate: 0.6, accountCode: '493' },
      per_diem: { rate: 80, accountCode: 'TRAVEL-1' },
    });

    // Four places for a rate per km; two for a rate per day; the ceilings themselves.
    await save({ MILEAGE_RATE: '0.5855', PER_DIEM_RATE: '10000' }).expect(200);
    expect(users.getUserConfig(user.id)).toMatchObject({ MILEAGE_RATE: '0.5855', PER_DIEM_RATE: '10000.00' });
    await save({ MILEAGE_RATE: '100' }).expect(200);
    expect(users.getUserConfig(user.id).MILEAGE_RATE).toBe('100.00');
    await save({ MILEAGE_RATE: '.45' }).expect(200);
    expect(users.getUserConfig(user.id).MILEAGE_RATE).toBe('0.45');

    // Another account's settings are its own.
    const other = await users.createUser(`other${Date.now()}@test.com`, 'password123', 'user');
    expect(users.getAllowanceSettings(other.id).mileage.rate).toBeNull();
  });

  test('a blank value clears it: the rate goes off, the account goes back to the claim account', async () => {
    await save({ MILEAGE_RATE: '0.60', MILEAGE_ACCOUNT_CODE: '493' }).expect(200);
    await save({ MILEAGE_RATE: '', MILEAGE_ACCOUNT_CODE: '' }).expect(200);
    const config = users.getUserConfig(user.id);
    expect(config.MILEAGE_RATE).toBeUndefined();
    expect(config.MILEAGE_ACCOUNT_CODE).toBeUndefined();
    expect(users.getAllowanceSettings(user.id).mileage).toEqual({ rate: null, accountCode: '429' });
  });

  test('anything that cannot be a rate is refused, and nothing in that save is kept', async () => {
    await save({ MILEAGE_RATE: '0.60', PER_DIEM_RATE: '80' }).expect(200);
    const refused = [
      { MILEAGE_RATE: '0' }, { MILEAGE_RATE: '-0.5' }, { MILEAGE_RATE: '0.12345' }, { MILEAGE_RATE: '100.01' },
      { MILEAGE_RATE: 'abc' }, { MILEAGE_RATE: '0,60' }, { MILEAGE_RATE: '1e2' }, { MILEAGE_RATE: '0.' }, { MILEAGE_RATE: '0x1' },
      { PER_DIEM_RATE: '80.123' }, { PER_DIEM_RATE: '10000.01' }, { PER_DIEM_RATE: '0.00' }, { PER_DIEM_RATE: 'eighty' },
      { MILEAGE_ACCOUNT_CODE: 'has space' }, { PER_DIEM_ACCOUNT_CODE: 'ELEVENCHARS' }, { PER_DIEM_ACCOUNT_CODE: '-12' },
    ];
    for (const patch of refused) {
      const res = await save({ ...patch, DEFAULT_CURRENCY: 'USD' }).expect(400);
      const [field] = Object.keys(patch);
      expect(res.body.errors.map(e => e.field)).toEqual([field]);
      expect(res.body.error).toBe(res.body.errors[0].error);
    }
    // The whole save was refused, the valid field beside the bad one included.
    expect(users.getUserConfig(user.id)).toMatchObject({ MILEAGE_RATE: '0.60', PER_DIEM_RATE: '80.00' });
    expect(users.getUserConfig(user.id).DEFAULT_CURRENCY).toBeUndefined();
  });

  test('the messages say what is allowed', async () => {
    const res = await save({ MILEAGE_RATE: '0.12345', PER_DIEM_RATE: '20000' }).expect(400);
    expect(res.body.errors).toEqual([
      { field: 'MILEAGE_RATE', error: 'Mileage rate per km must be a positive number with at most 4 decimal places, or blank to turn it off' },
      { field: 'PER_DIEM_RATE', error: 'Per diem daily rate must be at most 10,000' },
    ]);
  });

  test('a stored rate that would no longer pass is read as off rather than used', () => {
    users.saveUserConfig(user.id, { MILEAGE_RATE: '600', PER_DIEM_RATE: 'n/a' });
    expect(users.getAllowanceSettings(user.id)).toMatchObject({ mileage: { rate: null }, per_diem: { rate: null } });
  });

  test('saving needs a signed-in user', async () => {
    await request(serverFor(app)).post('/api/setup').send({ MILEAGE_RATE: '0.6' }).expect(401);
  });
});
