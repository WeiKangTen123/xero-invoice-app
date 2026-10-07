// Why xero/invoices.js uploads attachments with axios instead of the SDK.
//
// xero-node 7.0.0's createInvoiceAttachmentByFileName reads the file into an
// array of chunks and gives that ARRAY to axios as the body; axios serialises
// an array as JSON. So Xero is sent `[{"type":"Buffer","data":[...]}]` rather
// than the file. This runs the real SDK and the real axios request pipeline
// with a stub transport (nothing leaves the process) and records what would
// have gone on the wire. If an SDK upgrade makes this fail, the SDK sends the
// raw bytes again and invoices.js could go back to using it.
const axios = require('axios');
const { AccountingApi } = require('xero-node');

test('the SDK sends an attachment body as JSON, not as the file', async () => {
  let sent = null;
  // The SDK prints "JSON parse body failed" for any already-parsed reply.
  const quiet = jest.spyOn(console, 'log').mockImplementation(() => {});
  const api = new AccountingApi();
  api.accessToken = 'tok';
  const original = axios.defaults.adapter;
  axios.defaults.adapter = async config => {
    sent = config;
    return { data: '{"Attachments":[]}', status: 200, statusText: 'OK', headers: {}, config };
  };
  try {
    const file = Buffer.from('JPEGDATA');
    await api.createInvoiceAttachmentByFileName('tenant', 'inv', 'r.jpg', file, false);
  } finally {
    axios.defaults.adapter = original;
    quiet.mockRestore();
  }
  expect(sent).not.toBeNull();
  expect(Buffer.isBuffer(sent.data)).toBe(false);
  expect(String(sent.data)).toContain('"type":"Buffer"');
});
