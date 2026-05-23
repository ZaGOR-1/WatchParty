const { execSync } = require("node:child_process");

const TARGET_PORTS = new Set([4000, 5173, 5174, 5175, 5176]);

function getListeningPidsOnWindows() {
  let output = "";

  try {
    output = execSync("netstat -ano -p tcp", { encoding: "utf8" });
  } catch (error) {
    console.error("Не вдалося виконати netstat.");
    return [];
  }

  const pids = new Set();
  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (!match) {
      continue;
    }

    const port = Number(match[1]);
    const pid = Number(match[2]);

    if (!TARGET_PORTS.has(port) || !Number.isInteger(pid) || pid <= 0) {
      continue;
    }

    pids.add(pid);
  }

  return [...pids];
}

function killPid(pid) {
  if (pid === process.pid) {
    return false;
  }

  try {
    process.kill(pid);
    return true;
  } catch (error) {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
      return true;
    } catch (taskKillError) {
      return false;
    }
  }
}

function main() {
  if (process.platform !== "win32") {
    console.log("Скрипт stop:dev зараз налаштований для Windows.");
    process.exit(0);
  }

  const pids = getListeningPidsOnWindows();

  if (pids.length === 0) {
    console.log("Завислих dev-процесів на портах 4000/5173-5176 не знайдено.");
    process.exit(0);
  }

  const killed = [];
  const failed = [];

  for (const pid of pids) {
    if (killPid(pid)) {
      killed.push(pid);
    } else {
      failed.push(pid);
    }
  }

  if (killed.length > 0) {
    console.log(`Зупинено процеси PID: ${killed.join(", ")}`);
  }

  if (failed.length > 0) {
    console.log(`Не вдалося зупинити PID: ${failed.join(", ")}`);
    process.exit(1);
  }
}

main();

