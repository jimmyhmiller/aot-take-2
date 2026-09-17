// Runs every BenchmarkSuite the preceding Scripts registered and prints each result and the
// geometric-mean score, the way the suite's own run.html does. Load it after base.js and one or
// more benchmark files, in that order.
var success = true;

BenchmarkSuite.RunSuites({
  NotifyResult: function (name, result) {
    console.log(name + ": " + result);
  },
  NotifyError: function (name, error) {
    console.log(name + ": " + error);
    success = false;
  },
  NotifyScore: function (score) {
    if (success) console.log("Score (version " + BenchmarkSuite.version + "): " + score);
  }
});
