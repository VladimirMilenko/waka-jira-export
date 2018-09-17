const axios = require("axios");
const moment = require("moment");
const tough = require("tough-cookie");
const prompts = require("prompts");
const qs = require("querystring");
const _ = require("lodash");
const createLocalStorage = require("localstorage-ponyfill").createLocalStorage;
const axiosCookieJarSupport = require("@3846masa/axios-cookiejar-support")
  .default;

axiosCookieJarSupport(axios);
const localStorage = createLocalStorage();
let cookieJar = null;
let JIRALogin = "";
let JIRAPassword = "";

const jiraStorageIdentifier = "jira-cookies";

async function jiraGET(url, options = {}) {
  return axios.get(
    url,
    Object.assign(
      {
        jar: cookieJar,
        withCredentials: true
      },
      options
    )
  );
}
async function jiraPOST(url, data, options = {}) {
  return axios.post(
    url,
    data,
    Object.assign(
      {
        jar: cookieJar,
        withCredentials: true
      },
      options
    )
  );
}

async function loggedIn() {
  try {
    const response = await jiraGET(
      "https://jira.atlightspeed.net/rest/auth/latest/session"
    );
    return true;
  } catch (e) {
    return false;
  }
}

async function initializeJIRA() {
  if (localStorage.getItem("jira-login")) {
    JIRALogin = localStorage.getItem("jira-login");
  } else {
    const { value } = await prompts([
      {
        type: "text",
        name: "value",
        message: "Enter your jira login",
        style: "default"
      }
    ]);
    JIRALogin = value;
    localStorage.setItem("jira-login", JIRALogin);
  }
  const { value } = await prompts({
    type: "password",
    name: "value",
    message: "Enter your JIRA password"
  });
  JIRAPassword = value;
}

async function getSimilarIssuesByKey(value) {
  try {
    const response = await jiraGET(
      `https://jira.atlightspeed.net/rest/api/latest/search?jql=issuekey %3D "${value}"&maxResults=5`
    );
    return response.data.issues.map(x => ({
      title: x.key + " " + x.fields.summary,
      value: x.key
    }));
  } catch (e) {
    return [];
  }
}

async function getSimilarIssuesByText(value) {
  try {
    const response = await jiraGET(
      `https://jira.atlightspeed.net/rest/api/latest/search?jql=text~"${value}" OR summary ~ "${value}"&maxResults=5`
    );
    return response.data.issues.map(x => ({
      title: x.key + " " + x.fields.summary,
      value: x.key
    }));
  } catch (e) {
    return [];
  }
}

async function getSimilarIssuesAutocomplete(title) {
  try {
    const issueKey = await getSimilarIssuesByKey(title);
    const rest = await getSimilarIssuesByText(title);
    return _.uniqBy(_.concat(issueKey, rest), x => x.value);
  } catch (e) {
    return [];
  }
}
async function getSimilarIssues(title, notSplitted = false) {
  let finalTitle = title;
  if (!notSplitted) {
    let finalTitleWithUsername = title.split(" · Pull Request")[0];
    const parsedTitle = finalTitleWithUsername.split(" by");
    parsedTitle.splice(-1);
    finalTitle = parsedTitle.join("");
  }
  try {
    return await getSimilarIssuesByParam(
      "text",
      `${title} OR summary ~ ${title}`
    );
  } catch (e) {
    return [];
  }
}

async function logWorkToJira(jiraId, started_at, durationSeconds, comment) {
  try {
    const response = await jiraPOST(
      `https://jira.atlightspeed.net/rest/api/latest/issue/${jiraId}/worklog`,
      {
        timeSpentSeconds: durationSeconds.toString(),
        started: moment
          .unix(started_at)
          .utc()
          .format("YYYY-MM-DD[T]HH:mm:ss.000+0000"),
        comment: comment
      }
    );
  } catch (e) {}
}

async function start() {
  let activeCookies = false;
  if (localStorage.getItem(jiraStorageIdentifier)) {
    cookieJar = tough.CookieJar.fromJSON(
      localStorage.getItem(jiraStorageIdentifier)
    );
    activeCookies = await loggedIn();
  }
  if (!cookieJar || !activeCookies) {
    console.log("No stored cookies found or cookies are invalid");
    cookieJar = new tough.CookieJar();
    await initializeJIRA();
    let loginData = qs.stringify({
      os_username: JIRALogin,
      os_password: JIRAPassword,
      os_cookie: true,
      os_destination: "",
      user_role: "",
      atl_token: "",
      login: "Log In"
    });
    try {
      await jiraPOST("https://jira.atlightspeed.net/login.jsp", loginData, {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        }
      });
      console.log("Attempt 1...");
      activeCookies = await loggedIn();
      localStorage.setItem("jira-cookies", JSON.stringify(cookieJar));
    } catch (e) {
      console.log("Unable to authenticate");
      console.error(e);
    }
  }
  if (activeCookies) {
    console.log("Logged in!");
  } else {
    console.log("Unable to log in");
  }
}

module.exports = {
  getSimilarIssues,
  getSimilarIssuesAutocomplete,
  logWorkToJira,
  start
};
