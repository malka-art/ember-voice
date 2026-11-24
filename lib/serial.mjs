// Runs jobs one after another, in the order they were handed in, even when
// each one waits on something slow. A job that fails does not stop the ones
// after it.
//
// The bar keeps listening while a sentence is being turned into text, so two
// sentences can be on their way at once. They must reach the thread in the
// order you said them.
export function createSerialQueue() {
  let tail = Promise.resolve();
  return function run(job) {
    const result = tail.then(job);
    tail = result.catch(() => {});
    return result;
  };
}
