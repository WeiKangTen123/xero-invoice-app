// Why xero/invoices.js uploads attachments with axios instead of the SDK.
//
// xero-node 7.0.0's createInvoiceAttachmentByFileName gave axios the file as
// an array of chunks, which axios serialises as JSON, so Xero was sent
// `[{"type":"Buffer","data":[...]}]` rather than the file. 9.0.0 fixed that and
// the SDK now sends the bytes. What it still does not send is the file's own
// type: with no headers passed in, the upload goes out as
// application/x-www-form-urlencoded, and the endpoint takes the file's type
// from Content-Type. So invoices.js keeps its direct PUT, which sends the
// real type. Moving back to the SDK would mean passing
// { headers: { 'Content-Type': mime } } as its last argument, and confirming
// against live Xero that a PDF and a JPEG still open from the bill.
//
// This runs the real SDK and the real axios request pipeline with a stub
// transport (nothing leaves the process) and records what would have gone on
// the wire.
const axios = require('axios');
const { AccountingApi } = require('xero-node');

async function sendWithSdk(...extra) {
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
    await api.createInvoiceAttachmentByFileName('tenant', 'inv', 'r.jpg', Buffer.from('JPEGDATA'), false, ...extra);
  } finally {
    axios.defaults.adapter = original;
    quiet.mockRestore();
  }
  expect(sent).not.toBeNull();
  return sent;
}

const contentType = config => (typeof config.headers.get === 'function'
  ? config.headers.get('content-type')
  : config.headers['Content-Type']);

test('the SDK sends an attachment body as the file itself', async () => {
  const sent = await sendWithSdk();
  expect(Buffer.isBuffer(sent.data)).toBe(true);
  expect(sent.data.equals(Buffer.from('JPEGDATA'))).toBe(true);
});

test('but labels it with a form content type unless the caller passes one', async () => {
  expect(contentType(await sendWithSdk())).toBe('application/x-www-form-urlencoded');
  expect(contentType(await sendWithSdk(undefined, { headers: { 'Content-Type': 'image/jpeg' } }))).toBe('image/jpeg');
});
