const axios = require("axios");
const chalk = require("chalk");
const prompts = require("prompts");
const moment = require("moment");
const createLocalStorage = require("localstorage-ponyfill").createLocalStorage;
const momentDurationFormatSetup = require("moment-duration-format");
momentDurationFormatSetup(moment);
const jiraApi = require("./jira-api");

let pullRequestMap = {};
let coding = {};
let debugging = {};
let titleToJira = {};
let branchToJira = {};

function parsePullRequestReview(pullRequestHeartbeat, data) {
  const heartBeats = data.filter(x => x.entity === pullRequestHeartbeat.entity);
  return calculateWebHeartbeats(heartBeats);
}

function calculateWebHeartbeats(heartbeats, threshold = 5 * 60) {
  let lastActiveRecordTime = 0;
  const result = heartbeats.reduce((prev, current) => {
    const prevEntry = prev[lastActiveRecordTime];
    if (!prevEntry) {
      lastActiveRecordTime = current.time;
      return {
        ...prev,
        [current.time]: {
          totalTime: 0,
          startTime: current.time,
          prevTime: current.time
        }
      };
    }

    const diff = current.time - prevEntry.prevTime;
    const abandoned = diff > threshold;

    if (abandoned) {
      let returnObj = {
        ...prev,
        [lastActiveRecordTime]: {
          ...prevEntry,
          totalTime: prevEntry.totalTime + threshold / 2
        },
        [current.time]: {
          totalTime: 0,
          startTime: current.time,
          prevTime: current.time
        }
      };
      lastActiveRecordTime = current.time;
      return returnObj;
    } else {
      return {
        ...prev,
        [lastActiveRecordTime]: {
          totalTime: prevEntry.totalTime + diff,
          startTime: prevEntry.startTime,
          prevTime: current.time
        }
      };
    }
  }, {});
  const totalTime =
    Object.keys(result).reduce(
      (prev, current) => prev + result[current].totalTime,
      0
    ) || threshold / 2;
  return {
    startTime: Object.keys(result)[0],
    totalTime
  };
}

const messageMap = {};
function getClosestBranch(time, project, data) {
  const suitable = data.filter(x => {
    return (
      x.category === "coding" &&
      x.project === project &&
      (x.time <= time || x.time - time <= 10 * 60)
    );
  });
  suitable.sort((a, b) => a.time - b.time);
  if (!suitable.length) {
    return null;
  }
  return suitable.reverse()[0].branch;
}

function processDebugging(entity, data) {
  const branch = getClosestBranch(entity.time, entity.project, data);
  const debuggingHeartbeats = data.filter(
    x =>
      x.category === "debugging" &&
      getClosestBranch(x.time, x.project, data) === branch
  );
  const result = calculateWebHeartbeats(debuggingHeartbeats, 1 * 60);
  return result;
}

function processCoding(entity, data) {
  const debuggingHeartbeats = data.filter(
    x => x.category === "coding" && x.branch === entity.branch
  );
  const result = calculateWebHeartbeats(debuggingHeartbeats, 2 * 60);
  return result;
}

function mergeCodingAndDebugging() {
  const total = {};
  Object.keys(debugging).map(x => {
    total[x] = debugging[x];
  });
  Object.keys(coding).map(x => {
    if (total[x]) {
      total[x] = {
        startTime: Math.min(total[x].startTime, coding[x].startTime),
        totalTime: total[x].totalTime + coding[x].totalTime
      };
    } else {
      total[x] = coding[x];
    }
  });
  return total;
}

async function processTimelines(data) {
  console.log(chalk.green("Processing timelines..."));

  data.map(x => {
    if (x.category === "code reviewing" && !pullRequestMap[x.entity]) {
      pullRequestMap[x.entity] = parsePullRequestReview(x, data);
    }
    if (x.category === "debugging" && !debugging[x.entity]) {
      let branch = getClosestBranch(x.time, x.project, data);
      if (branch) {
        debugging[branch] = processDebugging(x, data);
      }
    }
    if (x.category === "coding" && !coding[x.entity]) {
      coding[x.branch] = processCoding(x, data);
    }
  });
  const developmentMap = mergeCodingAndDebugging();

  for (const pullRequest in pullRequestMap) {
    if (pullRequestMap[pullRequest].totalTime) {
      try {
        console.log(chalk.bgWhite("\n=====================\n"));
        console.log(
          chalk.blue(
            `Processing review of ${chalk.blue.underline(pullRequest)}`
          )
        );

        const result = await pullRequestToJira(
          pullRequest,
          pullRequestMap[pullRequest]
        );
        if (!result.id) continue;
        const entry = result.data;

        await jiraApi.logWorkToJira(
          result.id,
          entry.startTime,
          Math.ceil(entry.totalTime / 60) * 60,
          "Pull request review"
        );

        console.log(
          chalk.green(`Logged pull request review on PR: ${pullRequest}`)
        );
      } catch (e) {
        console.log(
          `${chalk.black.bgRed("ERROR:")}: ${chalk.red(
            `Error during logging pr review ${pullRequest}`
          )}`
        );
      }
    }
  }

  for (const branch in developmentMap) {
    if (developmentMap[branch].totalTime) {
      try {
        console.log(chalk.bgWhite("\n=====================\n"));
        console.log(
          chalk.blue(
            `Processing development on branch ${chalk.blue.underline(branch)}`
          )
        );

        const result = await branchToJiraId(branch, developmentMap[branch]);
        const entry = result.data;
        if (!result.id) continue;

        await jiraApi.logWorkToJira(
          result.id,
          entry.startTime,
          Math.ceil(entry.totalTime / 60) * 60,
          "Development and debugging"
        );
        console.log(
          chalk.black.bgGreen("SUCCESS:") +
            chalk.green(`   Logged work on branch: ${branch}`)
        );
      } catch (e) {
        console.log(
          `${chalk.black.bgRed("ERROR:")}: ${chalk.red(
            `Error during logging work on ${branch}`
          )}`
        );
      }
    }
  }
}

async function getAutocompleteForIssue(title, options = {}) {
  const issues = await jiraApi.getSimilarIssues(title);
  const question = {
    type: "autocomplete",
    name: "value",
    message: "Pick the correct JIRA Ticket",
    choices: issues,
    limit: 10
  };
  if (options.autoSuggest) {
    question.suggest = (input, choices) => {
      if (!input) {
        return Promise.resolve([]);
      }
      return jiraApi.getSimilarIssuesAutocomplete(input);
    };
  }
  const { value } = await prompts(question);
  return value;
}

async function branchToJiraId(title, object) {
  const identifierMatches = title.match(/CAM-\d+/);
  if (branchToJira[title]) {
    return {
      id: branchToJira[title],
      data: object
    };
  }
  if (
    !identifierMatches ||
    (!identifierMatches.length && !branchToJira[title])
  ) {
    console.log(
      chalk.black.bgYellow("WARNING:") +
        chalk.yellow(
          `    Cannot find JIRA identifier for branch: ${chalk.yellow.underline(
            title
          )}`
        )
    );
    branchToJira[title] = await getAutocompleteForIssue(title, {
      autoSuggest: true
    });
  } else {
    if (branchToJira[title]) {
      console.log(`Right issue for branch: ${title} is ${branchToJira[title]}`);
    } else {
      console.log(
        chalk.bgCyan.black("MATCHING IDENTIFIER:") +
          "  " +
          chalk.cyan(
            `${identifierMatches[0]} is correct for ${chalk.cyan.underline(
              title
            )}`
          )
      );
      const question = {
        type: "toggle",
        name: "value",
        message: "Can you confirm this?",
        initial: true,
        active: "yes",
        inactive: "no"
      };
      const { value } = await prompts(question);
      if (value) {
        branchToJira[title] = identifierMatches[0];
      } else {
        branchToJira[title] = await getAutocompleteForIssue(title, {
          autoSuggest: true
        });
      }
    }
  }
  return {
    id: branchToJira[title],
    data: object
  };
}

async function pullRequestToJira(title, object) {
  const identifierMatches = title.match(/CAM-\d+/);
  if (titleToJira[title]) {
    return {
      id: titleToJira[title],
      data: object
    };
  }
  if (
    !identifierMatches ||
    (!identifierMatches.length && !titleToJira[title])
  ) {
    console.log(
      chalk.black.bgYellow("WARNING:") +
        chalk.yellow(
          `    Cannot find JIRA identifier for pull-request: ${chalk.yellow.underline(
            title
          )}`
        )
    );
    titleToJira[title] = await getAutocompleteForIssue(title, {
      autoSuggest: true
    });
  } else {
    if (titleToJira[title]) {
      console.log(`Right issue for PR: ${title} is ${titleToJira[title]}`);
    } else {
      console.log(
        chalk.bgCyan.black("MATCHING IDENTIFIER:") +
          "  " +
          chalk.cyan(
            `${identifierMatches[0]} is correct for ${chalk.cyan.underline(
              title
            )}`
          )
      );
      const question = {
        type: "toggle",
        name: "value",
        message: "Can you confirm this?",
        initial: true,
        active: "yes",
        inactive: "no"
      };
      const { value } = await prompts(question);
      if (value) {
        titleToJira[title] = identifierMatches[0];
      } else {
        titleToJira[title] = await getAutocompleteForIssue(title, {
          autoSuggest: true
        });
      }
    }
  }
  return {
    id: titleToJira[title],
    data: object
  };
}

async function start() {
  await jiraApi.start();
  pullRequestMap = {};
  const currentDate = moment().format("YYYY-MM-DD");
  const question = {
    type: "text",
    name: "project",
    message: "Enter the project name to track",
    initial: "backend"
  };
  const projectResponse = await prompts(question);
  const response = await axios.get(
    `https://wakatime.com/api/v1/users/current/heartbeats?date=${currentDate}`,
    {
      headers: {
        Authorization:
          "Basic " + Buffer.from(process.env.API_KEY).toString("base64")
      }
    }
  );
  const timelines = response.data.data.filter(
    x => x.project === projectResponse.project
  );

  await processTimelines(timelines);
}

start();
