Error.stackTraceLimit = 1000;
require('../trace');

function loop (func) {
    const execute = () => {
        func().then(() => {
            setTimeout(execute, 0);
        });
    };
    execute();
}

console.log(`Stack trace limit is: ${Error.stackTraceLimit}`);

loop(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
});
