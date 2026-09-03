const { parseLlmJson, stripWrapping } = require('./llm-json');

// Four copies of this had drifted apart before it was pulled into one place:
// one stripped the newline after the opening fence and three did not, one
// matched ```JSON case-insensitively and three did not. These pin the union of
// what all four used to handle, plus the cases that split them.
describe('utils/llm-json', () => {
  const obj = { merchant: 'Grab', total: 18.4 };

  describe('the shapes models actually return', () => {
    test('bare JSON', () => {
      expect(parseLlmJson(JSON.stringify(obj))).toEqual(obj);
    });

    test('fenced with a json tag', () => {
      expect(parseLlmJson('```json\n' + JSON.stringify(obj) + '\n```')).toEqual(obj);
    });

    test('fenced without a tag', () => {
      expect(parseLlmJson('```\n' + JSON.stringify(obj) + '\n```')).toEqual(obj);
    });

    test('an uppercase fence tag — only one of the four copies handled this', () => {
      expect(parseLlmJson('```JSON\n' + JSON.stringify(obj) + '\n```')).toEqual(obj);
    });

    test('no newline after the fence — three of the four handled this', () => {
      expect(parseLlmJson('```json' + JSON.stringify(obj) + '```')).toEqual(obj);
    });

    test('a reasoning block before the answer', () => {
      expect(parseLlmJson('<thought>let me read it</thought>\n```json\n' + JSON.stringify(obj) + '\n```')).toEqual(obj);
    });

    test('several reasoning blocks', () => {
      expect(parseLlmJson('<thought>a</thought>x<thought>b</thought>' + JSON.stringify(obj))).toEqual(obj);
    });

    test('surrounding whitespace and stray newlines', () => {
      expect(parseLlmJson('\n\n  ```json\n' + JSON.stringify(obj) + '\n```  \n')).toEqual(obj);
    });

    test('an array rather than an object', () => {
      expect(parseLlmJson('```json\n[1,2,3]\n```')).toEqual([1, 2, 3]);
    });
  });

  describe('salvage', () => {
    test('JSON wrapped in a sentence is recovered', () => {
      expect(parseLlmJson(`Here is the result: ${JSON.stringify(obj)} — hope that helps!`)).toEqual(obj);
    });

    test('a clean reply is never put through salvage', () => {
      // Salvage takes the widest bracket span, which would mangle this.
      expect(parseLlmJson('{"a":{"b":1},"c":2}')).toEqual({ a: { b: 1 }, c: 2 });
    });
  });

  describe('failure is a value, not an exception', () => {
    test('prose with no JSON returns null', () => {
      expect(parseLlmJson('I could not read that receipt, sorry.')).toBeNull();
    });

    test('empty, null and undefined return null', () => {
      expect(parseLlmJson('')).toBeNull();
      expect(parseLlmJson(null)).toBeNull();
      expect(parseLlmJson(undefined)).toBeNull();
    });

    test('malformed JSON returns null rather than throwing', () => {
      expect(parseLlmJson('```json\n{"a": }\n```')).toBeNull();
      expect(() => parseLlmJson('{{{{')).not.toThrow();
    });
  });

  describe('stripWrapping', () => {
    test('leaves already-clean text alone', () => {
      expect(stripWrapping('{"a":1}')).toBe('{"a":1}');
    });
  });
});
