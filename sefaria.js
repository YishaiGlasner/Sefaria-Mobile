import { Alert, Platform } from 'react-native';
//import { GoogleAnalyticsTracker } from 'react-native-google-analytics-bridge'; //https://github.com/idehub/react-native-google-analytics-bridge/blob/master/README.md
import { unzip } from 'react-native-zip-archive'; //for unzipping -- (https://github.com/plrthink/react-native-zip-archive)
import AsyncStorage from '@react-native-async-storage/async-storage';
import crashlytics from '@react-native-firebase/crashlytics';
import VersionNumber from 'react-native-version-number';
import { Search } from '@sefaria/search';
import sanitizeHtml from 'sanitize-html'
import Api from './api';
import History from './history';
import LinkContent from './LinkContent';
import { initAsyncStorage } from './StateManager';
import { VOCALIZATION } from './VocalizationEnum';
import URL from 'url-parse';
import analytics from '@react-native-firebase/analytics';
import {FileSystem} from 'react-native-unimodules'
import {
  packageSetupProtocol,
  downloadUpdate,
  autoUpdateCheck,
  checkUpdatesFromServer,
  loadJSONFile,
  fileExists, FILE_DIRECTORY,
  simpleDelete,
} from './DownloadControl'
import { Topic } from './Topic';

const ERRORS = {
  NOT_OFFLINE: 1,
  NO_CONTEXT: 2,
  CANT_GET_SECTION_FROM_DATA: "Couldn't find section in depth 3+ text",
};

Sefaria = {
  _auth: {},
  recentQueries: [],
  people: {},
  init: async function(dispatch) {
    // numTimesOpenedApp
    const numTimesOpenedApp = await AsyncStorage.getItem("numTimesOpenedApp");
    Sefaria.numTimesOpenedApp = !!numTimesOpenedApp ? parseInt(numTimesOpenedApp) : 0;
    if (Sefaria.numTimesOpenedApp === 0) { AsyncStorage.setItem('lastSyncTime', '0'); }
    AsyncStorage.setItem("numTimesOpenedApp", JSON.stringify(Sefaria.numTimesOpenedApp + 1));
    Sefaria.lastAppUpdateTime = await Sefaria.getLastAppUpdateTime();
    await Sefaria._loadTOC();
    await Sefaria.history._loadHistoryItems();
    await initAsyncStorage(dispatch);
  },
  postInitSearch: function() {
    return Sefaria._loadRecentQueries()
      .then(Sefaria._loadSearchTOC);
  },
  postInit: function(networkSetting='wifiOnly') {
    return Sefaria._loadPeople()
      .then(Sefaria._loadHebrewCategories)
      .then(packageSetupProtocol)
      .then(autoUpdateCheck).then(async checkServer => {
        if (checkServer) {
          await checkUpdatesFromServer();
        }

        try {
          await downloadUpdate(networkSetting, false);  // this method compares what the user requested to what is on disk and retrieves anything missing
        } catch (e) {
          console.log('postInit download error');
          console.log(e);
        }
      })
  },
  getLastAppUpdateTime: async function() {
    // returns epoch time of last time the app was updated. used to compare if sources files are newer than downloaded files
    const lastAppVersionString = await AsyncStorage.getItem("lastAppVersionString");
    const currAppVersionString = VersionNumber.appVersion;
    let lastAppUpdateTime;
    if (lastAppVersionString !== currAppVersionString) {
      // app has updated
      lastAppUpdateTime = (new Date).getTime();
      AsyncStorage.setItem("lastAppUpdateTime", JSON.stringify(lastAppUpdateTime));
      AsyncStorage.setItem("lastAppVersionString", VersionNumber.appVersion);
    } else {
      // get stored time
      lastAppUpdateTime = await AsyncStorage.getItem("lastAppUpdateTime");
      lastAppUpdateTime = !!lastAppUpdateTime ? parseInt(lastAppUpdateTime) : 0;
    }
    return lastAppUpdateTime;
  },
  /*
  if `context` and you're using API, only return section no matter what. default is true
  versions is object with keys { en, he } specifying version titles of requested ref
  */
  data: function(ref, context, versions) {
    if (typeof context === "undefined") { context = true; }
    return new Promise(function(resolve, reject) {
      const bookRefStem  = Sefaria.textTitleForRef(ref);
      Sefaria.loadOfflineFile(ref, context, versions)
        .then(data => { Sefaria.processFileData(ref, data).then(resolve); })
        .catch(error => {
          if (error === ERRORS.NOT_OFFLINE) {
            Sefaria.loadFromApi(ref, context, versions, bookRefStem)
              .then(data => { Sefaria.processApiData(ref, context, versions, data).then(resolve); })
              .catch(error => {
                if (error.error === ERRORS.NO_CONTEXT) {
                  resolve(error.data);
                } else {
                  reject(error);
                }
              })
          } else {
            reject(error);
          }
        })
    });
  },
  getSectionFromJsonData: function(ref, data) {
    if ("content" in data) {
      return data;
    } else {
      // If the data file represents multiple sections, pick the appropriate one to return
      const refUpOne = Sefaria.refUpOne(ref);
      //console.log(ref, data.sections);
      if (ref in data.sections) {
        return data.sections[ref];
      } else if (refUpOne in data.sections) {
        return data.sections[refUpOne];
      } else {
        return;
      }
    }
  },
  refUpOne: function(ref) {
    //return ref up one level, assuming you can
    return ref.lastIndexOf(":") !== -1 ? ref.slice(0, ref.lastIndexOf(":")) : ref;
  },
  processFileData: function(ref, data) {
    return new Promise((resolve, reject) => {
      // Store data in in memory cache if it's not there already
      const result = Sefaria.getSectionFromJsonData(ref, data);
      if (!result) { reject(ERRORS.CANT_GET_SECTION_FROM_DATA); }
      // Annotate link objects with useful fields not included in export
      result.content.forEach(segment => {
        if ("links" in segment) {
          segment.links.map(link => {
            link.textTitle = Sefaria.textTitleForRef(link.sourceRef);
            if (!("category" in link)) {
              link.category = Sefaria.primaryCategoryForTitle(link.textTitle);
            }
          });
        }
      });
      result.requestedRef   = ref;
      result.isSectionLevel = (ref === result.sectionRef);
      Sefaria.cacheVersionInfo(result, true);
      resolve(result);
    });
  },
  processApiData: function(ref, context, versions, data) {
    return new Promise((resolve, reject) => {
      Sefaria.api.textCache(ref, context, versions, data);
      Sefaria.cacheVersionInfo(data, true);
      //console.log(data);
      resolve(data);
    });
  },
  shouldLoadFromApi: function(versions) {
    // there are currently two cases where we load from API even if the index is downloaded
    // 1) debugNoLibrary is true 2) you're loading a non-default version
    return Sefaria.util.objectHasNonNullValues(versions) || Sefaria.debugNoLibrary;
  },
  loadOfflineFile: async function(ref, context, versions) {
    var fileNameStem = ref.split(":")[0];
    var bookRefStem  = Sefaria.textTitleForRef(ref);
    //if you want to open a specific version, there is no json file. force an api call instead
    const shouldLoadFromApi = Sefaria.shouldLoadFromApi(versions);
    if (shouldLoadFromApi) { throw ERRORS.NOT_OFFLINE; }
    var jsonPath = Sefaria._JSONSourcePath(fileNameStem);
    var zipPath  = Sefaria._zipSourcePath(bookRefStem);
    // Pull data from in memory cache if available
    if (jsonPath in Sefaria._jsonData) {
      return Sefaria._jsonData[jsonPath];
    }

    const preResolve = data => {
      if (!(jsonPath in Sefaria._jsonData)) {
        Sefaria._jsonData[jsonPath] = data;
      }
      return data;
    };
    let data;
    try {
      data = await Sefaria._loadJSON(jsonPath);
      return preResolve(data);
    } catch (e) {
      const exists = await fileExists(zipPath);
      if (exists) {
        const path = await Sefaria._unzip(zipPath);
        try {
          data = await Sefaria._loadJSON(jsonPath);
          return preResolve(data);
        } catch (e2) {
          // Now that the file is unzipped, if there was an error assume we have a depth 1 text
          // NOAH 10/30/2019 not sure if this path is ever reached
          var depth1FilenameStem = fileNameStem.substr(0, fileNameStem.lastIndexOf(" "));
          var depth1JSONPath = Sefaria._JSONSourcePath(depth1FilenameStem);
          try {
            data = await Sefaria._loadJSON(depth1JSONPath);
            return preResolve(data);
          } catch (e3) {
            console.error("Error loading JSON file: " + jsonPath + " OR " + depth1JSONPath);
            throw ERRORS.NOT_OFFLINE;
          }
        }
      } else {
        throw ERRORS.NOT_OFFLINE;
      }
    }
  },
  loadFromApi: function(ref, context, versions, bookRefStem) {
    return new Promise((resolve, reject) => {
      // The zip doesn't exist yet, so make an API call
      const cacheValue = Sefaria.api.textCache(ref, context, versions);
      if (cacheValue) {
        // Don't check the API cahce until we've checked for a local file, because the API
        // cache may be left in a state with text but without links.
        resolve(cacheValue);
      }
      Sefaria.api._text(ref, { context, versions, stripItags: true })
        .then(data => {
          if (context) { resolve(data); }
          else         { reject({error: ERRORS.NO_CONTEXT, data}); }
        })
        .catch(function(error) {
          //console.error("Error with API: ", Sefaria.api._toURL(ref, false, 'text', true));
          reject(error);
      });
    });
  },
  _jsonData: {}, // in memory cache for JSON data
  _apiData: {},  // in memory cache for API data
  textTitleForRef: function(ref) {
    // Returns the book title named in `ref` by examining the list of known book titles.
    if (!ref) { return null; }
    for (let i = ref.length; i >= 0; i--) {
      let book = ref.slice(0, i);
      if (book in Sefaria.booksDict) {
        return book;
      }
    }
    return null;
  },
  sheetIdToUrl: sheetId => {
    return `https://www.sefaria.org/sheets/${sheetId}`;
  },
  refToFullUrl: ref => {
    return `https://www.sefaria.org/${Sefaria.refToUrl(ref)}`
  },
  refToUrl: ref => {
    // TODO: ideally should be using Sefaria.makeRef() (from Sefaria-Project) to urlify
    // this method works, but it doesn't generate identical urls to what the web client sends (last space before sections is a _ instead of .)
    // this means that it will not hit the same cache as the web client
    const book = Sefaria.textTitleForRef(ref);
    let url = ref;
    if (!book || ref.substr(book.length, 1) === ",") {
      // if complex, we don't know what the complex nodes are so use naive method which works but makes the last space before sections a _ instead of .
      url = ref.replace(/:/g,'.').replace(/ /g,'_');
    } else {
      // use book list to find last space before sections
      url = `${book.replace(/ /g, '_')}${ref.substring(book.length).replace(/:/g, '.').replace(/ (?=[^ ]+$)/, '.')}`
    }
    return url;
  },
  urlToRef: url => {
    // url: tref as it would appear in a url
    url = url.replace(/\./, ' ');  // first period is guarenteed to be separation between title and sections
    url = url.replace(/_/g, ' ');
    const title = Sefaria.textTitleForRef(url);
    if (!title) { return { ref: url, title }; }
    const ref = url.replace(/\./g, ':');
    return { ref, title };
  },
  primaryCategoryForTitle: function(title, isSheet) {
    if (isSheet) { return ["Sheets"]; }
    const index = Sefaria.index(title);
    if (!index) { return  null; }
    return index.primary_category;
  },
  categoriesForTitle: function(title, isSheet) {
    if (isSheet) { return ["Sheets"]; }
    const index = Sefaria.index(title);
    if (!index) { return null;}
    return index.categories;
  },
  categoryForRef: function(ref) {
    return Sefaria.primaryCategoryForTitle(Sefaria.textTitleForRef(ref));
  },
  categoriesForRef: ref => Sefaria.categoriesForTitle(Sefaria.textTitleForRef(ref)),
  getTitle: function(ref, heRef, isCommentary, isHe) {
      // This function seems to have been the source of a bug which only presented itself on Android Hermes
      // Fix was to avoid using this function: https://github.com/Sefaria/Sefaria-iOS/commit/facd85a541e434c6eb6c6e44fa272e5c68735ae3
      // Try to find an alternative to using this function
      const bookTitle = Sefaria.textTitleForRef(ref);
      const collectiveTitles = Sefaria.collectiveTitlesDict[bookTitle];
      if (collectiveTitles && isCommentary) {
        if (isHe) { return collectiveTitles.he; }
        else      { return collectiveTitles.en; }
      }
      if (isHe) {
        var engTitle = ref; //backwards compatibility for how this function was originally written
        ref = heRef;
        var engSeg = engTitle.split(":")[1];
        var engFileNameStem = engTitle.split(":")[0];
        var engSec = engFileNameStem.substring(engFileNameStem.lastIndexOf(" ")+1,engFileNameStem.length);

        var heDaf = Sefaria.hebrew.encodeHebrewDaf(engSec,"long");
        if (heDaf != null) {
          var fullHeDaf = heDaf + ":" + Sefaria.hebrew.encodeHebrewNumeral(engSeg);
        }
      }
      if (fullHeDaf) {
        var find = '[״׳]'; //remove geresh and gershaim
        var re = new RegExp(find, 'g');
        ref = ref.replace(re, '');
        var bookRefStem = ref.split(" " + fullHeDaf)[0];
      } else {
        var fileNameStem = ref.split(":")[0];
        var bookRefStem = fileNameStem.substring(0, fileNameStem.lastIndexOf(" "));
      }

      if (isCommentary) {
          var onInd = isHe ? bookRefStem.indexOf(" על ") : bookRefStem.indexOf(" on ");
          if (onInd != -1)
            bookRefStem = bookRefStem.substring(0,onInd);
      }
      return bookRefStem;
  },
  toHeSegmentRef: function(heSectionRef, enSegmentRef) {
    if (!heSectionRef) {
      try {
        // try to convert with some heuristics
        const enTitle = Sefaria.textTitleForRef(enSegmentRef);
        if (!enTitle) { return enSegmentRef; }
        const enSectionStr = enSegmentRef.replace(enTitle + ' ', '');
        const heTitle = Sefaria.index(enTitle).heTitle;
        if (enSectionStr.match(/(?:\d+:)*\d+(?:\-(?:\d+:)*\d)?$/)) {
          // simple text
          const heStartSections = enSectionStr.split('-')[0].split(':').map(s => Sefaria.hebrew.encodeHebrewNumeral(parseInt(s))).join(':');
          let heEndSections = '';
          if (enSectionStr.indexOf('-') !== -1) {
            heEndSections = '-' + enSectionStr.split('-')[1].split(':').map(s => Sefaria.hebrew.encodeHebrewNumeral(parseInt(s))).join(':');
          }
          return `${heTitle} ${heStartSections}${heEndSections}`;
        }
        return enSegmentRef;
      } catch (e) {
        return enSegmentRef;
      }
    }
    const enSections = enSegmentRef.substring(enSegmentRef.lastIndexOf(" ")+1).split(":");
    const heSections = heSectionRef.substring(heSectionRef.lastIndexOf(" ")+1).split(":");
    if (enSections.length === heSections.length) { return heSectionRef; }  // already segment level
    else if (heSections.length + 1 === enSections.length) {
      const segNum = parseInt(enSections[enSections.length-1]);
      if (!segNum) { return heSectionRef; }
      return `${heSectionRef}:${Sefaria.hebrew.encodeHebrewNumeral(segNum)}׳`
    } else {
      console.log("weirdness", heSectionRef, enSegmentRef);
      return heSectionRef;
    }
  },
  booksDict: {},
  collectiveTitlesDict: {},
  _index: {}, // Cache for text index records
  index: function(text, index) {
    if (!index) {
      return this._index[text];
    } else {
      this._index[text] = index;
    }
  },
  showSegmentNumbers: function(text) {
    let index = Sefaria.index(text);
    if (!index) return true; //default to true
    return ['Liturgy'].indexOf(index.categories[0]) == -1;
  },
  canBeContinuous: function(text) {
    const index = Sefaria.index(text);
    if (!index) { return false; } // default to false
    // removing Talmud for now because cts mode is broken
    return [].indexOf(index.categories[0]) != -1
  },
  canHaveAliyot: function(text) {
    const index = Sefaria.index(text);
    if (!index) { return false; }
    return index.categories.length === 2 && index.categories[1] === "Torah";
  },
  vowelToggleAvailability: function(segmentArray) {
    if(!segmentArray || segmentArray.length == 0) return VOCALIZATION.NONE;
    const sample = segmentArray[0]['he'];
    const vowels_re = /[\u05b0-\u05c3\u05c7]/g;
    const cantillation_re = /[\u0591-\u05af]/g;
    if (cantillation_re.test(sample)) {
      return VOCALIZATION.TAAMIM_AND_NIKKUD;
    } else if(vowels_re.test(sample)) {
      return VOCALIZATION.NIKKUD;
    } else {
      return VOCALIZATION.NONE;
    }
  },
  _loadTOC: function() {
    return Sefaria.util.openFileInSources("toc.json").then(data => {
      Sefaria.toc = data;
      Sefaria._cacheIndexFromToc(data, true);
    });
  },
  search_toc: null,
  _loadSearchTOC: function() {
    return Sefaria.util.openFileInSources('search_toc.json').then(data => {
      Sefaria.search_toc = data;
    });
  },
  _loadHebrewCategories: function() {
    return Sefaria.util.openFileInSources("hebrew_categories.json").then(data => {
      Sefaria.hebrewCategories = data;
      Sefaria.englishCategories = {}; // used for classifying cats in autocomplete
      Object.entries(data).forEach(([key, value]) => {
        Sefaria.englishCategories[value] = 1;
      });
    });
  },
  _loadPeople: function() {
    return Sefaria.util.openFileInSources("people.json").then(data => {
      Sefaria.people = data;
    });
  },
  //for debugging
  _removeBook: function(toc, book) {
    findCats = function(toc, book, cats) {
      for (let i = 0; i < toc.length; i++) {
        if ('title' in toc[i]) {
          if (toc[i].title == book) {
            cats.push(i);
            return cats;
          }
        } else {
          let newCats = cats.slice(0);
          newCats.push(i);
          let ret = findCats(toc[i].contents, book, newCats);
          if (ret) {
            return ret;
          }
        }
      }
    }
    var cats = findCats(toc, book, []);
    var newToc = Sefaria.util.clone(toc);
    var tempToc = newToc;
    for (var j = 0; j < cats.length-1; j++) {
      tempToc = tempToc[cats[j]].contents;
    }
    tempToc.splice(cats[cats.length-1],1);
    return newToc;
  },
  _cacheIndexFromToc: function(toc, isTopLevel=false) {
    // Unpacks contents of Sefaria.toc into index cache.
    if (isTopLevel) {
      Sefaria.topLevelCategories = [];
      Sefaria.booksDict = {};
      Sefaria.collectiveTitlesDict = {};
      Sefaria._index = {};
    }
    for (var i = 0; i < toc.length; i++) {
      if ("category" in toc[i]) {
        if (isTopLevel) { Sefaria.topLevelCategories.push(toc[i].category); }
        Sefaria._cacheIndexFromToc(toc[i].contents)
      } else {
        Sefaria.index(toc[i].title, toc[i]);
        Sefaria.booksDict[toc[i].title] = 1;
        if (toc[i].collectiveTitle) {
          Sefaria.collectiveTitlesDict[toc[i].title] = {en: toc[i].collectiveTitle, he: toc[i].heCollectiveTitle};
        }
      }
    }
  },
  topLevelCategories: [],  // useful for ordering categories in linkSummary
  toc: null,
  tocItemsByCategories: function(cats) {
    // Returns the TOC items that correspond to the list of categories 'cats'
    var list = Sefaria.toc
    for (var i = 0; i < cats.length; i++) {
      var found = false;
      for (var k = 0; k < list.length; k++) {
        if (list[k].category == cats[i]) {
          list = Sefaria.util.clone(list[k].contents);
          found = true;
          break;
        }
      }
      if (!found) {
        return [];
      }
    }
    return list;
  },
  _versionInfo: {},
  cacheVersionInfo: function(data, isSection) {
    //isSection = true if data has `sectionRef`. false if data has `title`
    attrs = ['versionTitle','heVersionTitle','versionNotes','heVersionNotes','license','heLicense','versionSource','heVersionSource','versionTitleInHebrew','heVersionTitleInHebrew','versionNotesInHebrew','heVersionNotesInHebrew'];
    cacheKey = isSection ? data.sectionRef : data.title;
    Sefaria._versionInfo[cacheKey] = {};
    attrs.map((attr)=>{
      Sefaria._versionInfo[cacheKey][attr] = data[attr];
    });
    //console.log("SETTING VERSION INFO", cacheKey, isSection,Sefaria._versionInfo[cacheKey]);
  },
  versionInfo: function(ref, title, vlang) {
    let versionInfo = {};
    let sectionInfo = Sefaria._versionInfo[ref];
    if (!sectionInfo) sectionInfo = {};
    let indexInfo = Sefaria._versionInfo[title];
    if (!indexInfo) indexInfo = {};
    attrs = ['versionTitle', 'versionTitleInHebrew', 'versionNotes', 'versionNotesInHebrew', 'license', 'versionSource'];
    let allFieldsUndefined = true;
    attrs.map((attr)=>{
      //if 'he', prepend 'he' to attr
      const enAttr = attr;
      if (vlang === 'hebrew') { attr = 'he' + attr[0].toUpperCase() + attr.substring(1); }
      versionInfo[enAttr] = !!sectionInfo[attr] ? sectionInfo[attr] : indexInfo[attr];
      if (!!versionInfo[enAttr]) { allFieldsUndefined = false; }
    });
    if (allFieldsUndefined) { versionInfo = null; }

    return versionInfo;
  },
  commentaryList: function(title) {
    // Returns the list of commentaries for 'title' which are found in Sefaria.toc
    var index = this.index(title);
    if (!index) { return []; }
    var cats = [index.categories[0], "Commentary"]; //NOTE backwards compatibility
    var isCommentaryRefactor = this.isTOCCommentaryRefactor();
    if (isCommentaryRefactor) {
      cats = [index.categories[0]];
    }
    var branch = this.tocItemsByCategories(cats);


    var commentariesInBranch = function(title, branch) {
      // Recursively walk a branch of TOC, return a list of all commentaries found on `title`.
      var results = [];
      for (var i=0; i < branch.length; i++) {
        if (branch[i].title) {
          if (isCommentaryRefactor) {
            if (branch[i].dependence === "Commentary" && !!branch[i].base_text_titles && branch[i].base_text_titles.includes(title)) {
              results.push(branch[i]);
            }
          } else {
            var split = branch[i].title.split(" on ");
            if (split.length == 2 && split[1] === title) {
              results.push(branch[i]);
            }
          }

        } else {
          results = results.concat(commentariesInBranch(title, branch[i].contents));
        }
      }
      return results;
    };
    let comms = commentariesInBranch(title, branch);
    //console.log("isComms", isCommentaryRefactor, "comms",comms);
    return comms;
  },
  isTOCCommentaryRefactor: function() {
    var list = Sefaria.toc;
    var leafSeen = false; // once we see the first leaf, we can check for `dependence` field
    while (!leafSeen) {
      if (list[0].hasOwnProperty('title')) {
        leafSeen = true;
        return list[0].hasOwnProperty('dependence');
      } else {
        list = list[0].contents;
      }
    }
    return false;
  },
  _commentatorListBySection: {},
  commentatorListBySection: function(ref) {
    return Sefaria._commentatorListBySection[ref];
  },
  cacheCommentatorListBySection: function(ref, data) {
    if (ref in Sefaria._commentatorListBySection) { return; }
    const en = new Set();
    const he = new Set();
    for (let i = 0; i < data.length; i++) {
      if (!("links" in data[i])) { continue; }
      for (let j =0; j < data[i].links.length; j++) {
        const link = data[i].links[j];
        if (link.category === "Commentary") {
          const tempIndex = Sefaria.index(link.textTitle);
          if (!tempIndex) { continue; }
          const enTitle = link.collectiveTitle || link.textTitle;
          let heTitle = link.heCollectiveTitle || tempIndex.heTitle;
          if (!enTitle || !heTitle) { continue; }
          en.add(enTitle);
          he.add(heTitle);
        }
      }
    }
    const commentators = {
      en: [...en],
      he: [...he]
    }
    Sefaria._commentatorListBySection[ref] = commentators;
  },
  _textToc: {},
  textToc: function(title) {
    return new Promise((resolve, reject) => {
      const resolver = function(data) {
        data = Sefaria._fixTalmudAltStructAddressTypes(data);
        Sefaria._textToc[title] = data;
        Sefaria.cacheVersionInfo(data,false);
        resolve(data);
      };
      if (title in Sefaria._textToc) {
        resolve(Sefaria._textToc[title]);
      } else {
        const path = Sefaria._JSONSourcePath(title + "_index");
        Sefaria
        ._loadJSON(path)
        .then(resolver)
        .catch(()=>{Sefaria.api._request(title, 'index', true, {}).then(resolver)});
      }
    });
  },
  _fixTalmudAltStructAddressTypes: function(textToc) {
    // This is a bandaid on what may or may not be bad data. For Talmud alt struct "Chapter", we want to display
    // sections with Talmud address type, but the data current lists them as Integer.
    if (textToc.categories.length == 3 &&
        textToc.categories[0] == "Talmud" &&
        textToc.categories[1] == "Bavli" &&
        textToc.categories[2].indexOf("Seder ") != -1) {
      for (var i = 0; i < textToc.alts.Chapters.nodes.length; i++) {
        textToc.alts.Chapters.nodes[i].addressTypes = ["Talmud"];
      }
    }
    return textToc;
  },
  reformatTalmudContent(segment) {
    return segment
      .replace(/<span\s+class="gemarra-regular">(.+?)<\/span>/g, '<gemarraregular>$1</gemarraregular>')
      .replace(/<span\s+class="gemarra-italic">(.+?)<\/span>/g, '<gemarraitalic>$1</gemarraitalic>')
      .replace(/<span\s+class="it-text">(.+?)<\/span>/g, '<i>$1</i>')
  },
  categoryAttribution: function(categories) {
    var attributions = [
      {
        categories: ["Talmud", "Bavli"],
        english: "The William Davidson Talmud",
        hebrew: "תלמוד מהדורת ויליאם דוידסון",
        link: "https://www.sefaria.org/william-davidson-talmud"
      }
    ];
    var attribution = null;
    for (var i = 0; i < attributions.length; i++) {
      if (categories && categories.length >= attributions[i].categories.length &&
        Sefaria.util.compareArrays(attributions[i].categories, categories.slice(0, attributions[i].categories.length))) {
        attribution = attributions[i];
        break;
      }
    }
    return attribution;
  },
  calendar: null,
  _loadCalendar: async function() {
    const data = await Sefaria.util.openFileInSources("calendar.json");
    Sefaria.calendar = data;
  },
  topic_toc: null,
  loadTopicToc: async function () {
    const data = await Sefaria.util.openFileInSources("topic_toc.json");
    Sefaria.topic_toc = data;
    Sefaria._initTopicTocPages();
  },
  _topicTocPages: null,
  _topicTocObjectMap: {},  // dictionary from slug to topic object as it appears in topicToc
  _initTopicTocPages: function() {
    Sefaria._topicTocPages = Sefaria.topic_toc.reduce(Sefaria._initTopicTocReducer, {});
    Sefaria._topicTocPages[Sefaria._topicTocPageKey(null)] = Sefaria.topic_toc.map(({children, ...goodstuff}) => goodstuff);
  },
  _initTopicTocReducer: function(a,c) {
    Sefaria._topicTocObjectMap[c.slug] = new Topic({...c, title: {en: c.en, he: c.he}});
    if (!c.children) { return a; }
    a[Sefaria._topicTocPageKey(c.slug)] = c.children;
    for (let sub_c of c.children) {
      Sefaria._initTopicTocReducer(a, sub_c);
    }
    return a;
  },
  _topicTocCategory: null,
  _initTopicTocCategory: function() {
    Sefaria._topicTocCategory = Sefaria.topic_toc.reduce(Sefaria._initTopicTocCategoryReducer, {});
  },
  _initTopicTocCategoryReducer: function(a,c) {
    if (!c.children) {
      a[c.slug] = c.parent;
      return a;
    }
    for (let sub_c of c.children) {
      sub_c.parent = { en: c.en, he: c.he, slug: c.slug };
      Sefaria._initTopicTocCategoryReducer(a, sub_c);
    }
    return a;
  },
  _topicTocPageKey: slug => "_" + slug,
  topicTocPage: function(parent) {
    // if parent === null, return toc page for root
    if (!Sefaria.topic_toc) { return; }
    const key = Sefaria._topicTocPageKey(parent);
    return Sefaria._topicTocPages[key];
  },
  getTopicTocObject: (slug) => {
    return Sefaria._topicTocObjectMap[slug];
  },
  topicTocCategory: function(slug) {
    // return category english and hebrew for slug
    // return null if slug has no category (useful for passing result into topicTocPage())
    if (!this._topicTocCategory) { this._initTopicTocCategory(); }
    return this._topicTocCategory[slug] || null;
  },
  isTopicTopLevel: function(slug) {
    // returns true is `slug` is part of the top level of topic toc
    return Sefaria.topic_toc.filter(x => x.slug == slug).length > 0;
  },
  galusOrIsrael: null,
  getGalusStatus: function() {
    return fetch('https://www.geoip-db.com/json')
      .then(res => res.json())
      .then(data => {
        if (data.country_code == "IL") {
          Sefaria.galusOrIsrael = "israel"
        } else {
          Sefaria.galusOrIsrael = "diaspora"
        }
        return Sefaria.galusOrIsrael;
      })
      .catch(()=> {Sefaria.galusOrIsrael = "diaspora";})
  },


  getCalendars: function(custom, diaspora) {
    if (!Sefaria.calendar) { return []; }
    const dateString = Sefaria._dateString();
    const cal_obj = Sefaria.calendar[dateString];
    if (!cal_obj) { return []; }
    const preference_key = `${diaspora ? 1 : 0}|${custom[0]}`;
    const cal_items = cal_obj[preference_key] || [];
    const existing_items = new Set(cal_items.map(c => c.title.en));
    for (let c of cal_obj.d) {
      if (!existing_items.has(c.title.en)) {
        cal_items.push(c);
      }
    }
    return cal_items.sort((a, b) => a.order - b.order);
  },
  _dateString: function(date) {
    // Returns of string in the format "DD/MM/YYYY" for either `date` or today.
    var date = typeof date === 'undefined' ? new Date() : date;
    var day = ('0' + date.getDate()).slice(-2);
    var month = ('0' + (date.getMonth()+1)).slice(-2); //January is 0!
    var year = date.getFullYear();

    return `${year}-${month}-${day}`;
  },
  saveRecentQuery: function(query, type, key, pic) {
    //type = ["ref", "book", "person", "toc", "query", "topic", "user"]
    const newQuery = {query, type, key, pic};
    if (Sefaria.recentQueries.length > 0 && Sefaria.recentQueries[0].query === newQuery.query && Sefaria.recentQueries[0].type === newQuery.type) {
      return;  // don't add duplicate queries in a row
    }
    Sefaria.recentQueries.unshift(newQuery);
    Sefaria.recentQueries = Sefaria.recentQueries.slice(0,100);
    AsyncStorage.setItem("recentQueries", JSON.stringify(Sefaria.recentQueries)).catch(function(error) {
      console.error("AsyncStorage failed to save: " + error);
    });
  },
  _loadRecentQueries: function() {
    //return AsyncStorage.setItem("recentQueries", JSON.stringify([]));
    return AsyncStorage.getItem("recentQueries").then(function(data) {
      Sefaria.recentQueries = JSON.parse(data) || [];
    });
  },
  _deleteUnzippedFiles: function() {
    return new Promise((resolve, reject) => {
      FileSystem.readDirectoryAsync(FileSystem.documentDirectory).then(fileList => {
        for (let f of fileList) {
          if (f.endsWith(".json")) {
            //console.log('deleting', f.path);
            simpleDelete(`${FileSystem.documentDirectory}/${f}`).then(() => {});
          }
        }
        resolve();
      });
    });
  },
  _unzip: function(zipSourcePath) {
    return unzip(zipSourcePath, FileSystem.documentDirectory);
  },
  _loadJSON: function(JSONSourcePath) {
    return loadJSONFile(JSONSourcePath)
  },
  _JSONSourcePath: function(fileName) {
    return (FileSystem.documentDirectory + "/" + fileName + ".json");
  },
  _zipSourcePath: function(fileName) {
    return (FileSystem.documentDirectory + "/library/" + fileName + ".zip");
  },
  textFromRefData: function(data) {
    // Returns a dictionary of the form {en: "", he: "", sectionRef: ""} that includes a single string with
    // Hebrew and English for `data.requestedRef` found in `data` as returned from Sefaria.data.
    // sectionRef is so that we know which file / api call to make to open this text
    // `data.requestedRef` may be either section or segment level or ranged ref.
    if (data.isSectionLevel) {
      let enText = "", heText = "";
      for (let i = 0; i < data.content.length; i++) {
        let item = data.content[i];
        if (typeof item.text === "string") enText += item.text + " ";
        if (typeof item.he === "string") heText += item.he + " ";
      }
      return new LinkContent(enText, heText, data.sectionRef);
    } else {
      let segmentNumber = data.requestedRef.slice(data.ref.length+1);
      let toSegmentNumber = -1;
      let dashIndex = segmentNumber.indexOf("-");
      if (dashIndex !== -1) {
        toSegmentNumber = parseInt(segmentNumber.slice(dashIndex+1));
        segmentNumber = parseInt(segmentNumber.slice(0, dashIndex));
      } else { segmentNumber = parseInt(segmentNumber); }
      let enText = "";
      let heText = "";
      for (let i = 0; i < data.content.length; i++) {
        let item = data.content[i];
        const currSegNum = parseInt(item.segmentNumber);
        if (currSegNum >= segmentNumber && (toSegmentNumber === -1 || currSegNum <= toSegmentNumber)) {
            if (typeof item.text === "string") enText += item.text + " ";
            if (typeof item.he === "string") heText += item.he + " ";
            if (toSegmentNumber === -1) {
              break; //not a ranged ref
            }
        }
      }
      return new LinkContent(enText, heText, data.sectionRef);
    }
  },
  isGettinToBePurimTime: function() {
    const msInDay = 1000*60*60*24;
    const purimsOfTheFuture = [[2020, 2, 10], [2021, 1, 26], [2022, 2, 17], [2023, 2, 7], [2024, 2, 24], [2025, 2, 14], [2026, 2, 4], [2027, 2, 24], [2028, 2, 12], [2029, 2, 2]];

    const now = new Date();
    for (let potentialPurim of purimsOfTheFuture) {
      const daysLeft = ((new Date(...potentialPurim)) - now)/msInDay;
      if (daysLeft < 7 && daysLeft > -3) {
        return true;
      }
    }
    return false;
  },
  links: {
    _linkContentLoadingStack: [],
    /* when you switch segments, delete stack and hashtable */
    reset: function() {
      Sefaria.links._linkContentLoadingStack = [];
    },
    relatedCacheKey(ref, online) {
      return `${ref}|${online}`;
    },
    loadRelated: async function(ref, online) {
      if (online) {
        const data = await Sefaria.api.related(ref);
        return data;
      } else {
        const cacheKey = Sefaria.links.relatedCacheKey(ref, online);
        const cached = Sefaria.api._related[cacheKey];
        if (!!cached) { return cached; }
        const data = await Sefaria.loadOfflineFile(ref, false);
        // mimic response of links API so that addLinksToText() will work independent of data source
        const sectionData = Sefaria.getSectionFromJsonData(ref, data);
        if (!sectionData) { throw ERRORS.CANT_GET_SECTION_FROM_DATA; }
        const linkList = (sectionData.content.reduce((accum, segment, segNum) => accum.concat(
          ("links" in segment) ? segment.links.map(link => {
            const index_title = Sefaria.textTitleForRef(link.sourceRef);
            const collectiveTitle = Sefaria.collectiveTitlesDict[index_title];
            return {
              sourceRef: link.sourceRef,
              sourceHeRef: link.sourceHeRef,
              index_title,
              collectiveTitle,
              category: ("category" in link) ? link.category : Sefaria.primaryCategoryForTitle(index_title),
              anchorRef: `${ref}:${segNum+1}`,
              sourceHasEn: link.sourceHasEn,
            }
          }) : []
        ), []));
        const offlineRelatedData = {links: linkList};
        Sefaria.api._related[cacheKey] = offlineRelatedData;
        return offlineRelatedData;
      }
    },
    getSegmentIndexFromRef: function(ref) {
      let index = parseInt(ref.substring(ref.lastIndexOf(':') + 1)) - 1;
      if (!index && index !== 0) {
        // try again. assume depth-1 text
        index = parseInt(ref.substring(ref.lastIndexOf(' ') + 1).trim()) - 1;
      }
      return index;
    },
    organizeRelatedBySegment: function(related) {
      let output = {};
      //filter out books not in toc
      Object.entries(related).map(([key, valueList]) => {
        if (key == 'links') { valueList = valueList.filter(l=>!!Sefaria.booksDict[l.index_title]); }
        output[key] = [];
        for (let value of valueList) {
          if (value.expandedRefs) {
            delete value.expandedRefs;
          }
          const anchors = value.anchorRefExpanded || [value.anchorRef];
          if (anchors.length === 0) { continue; }
          for (let anchor of anchors) {
            const refIndex = Sefaria.links.getSegmentIndexFromRef(anchor);
            if (!output[key][refIndex]) { output[key][refIndex] = []; }
            let outputValue = value;
            if (key == 'links') {
              outputValue = {
                "category": value.category,
                "sourceRef": value.sourceRef,
                "sourceHeRef": value.sourceHeRef,
                "textTitle": value.index_title,
                "sourceHasEn": value.sourceHasEn,
                "collectiveTitle": value.collectiveTitle ? value.collectiveTitle.en: null,
                "heCollectiveTitle": value.collectiveTitle ? value.collectiveTitle.he : null,
              };
            }
            output[key][refIndex].push(outputValue);
          }
        }
      });
      return output;
    },
    addRelatedToSheet: function(sheet, related, sourceRef) {
      const related_obj = Sefaria.links.organizeRelatedBySegment(related);
      const sheetSegIndexes = [];
      for (let i = 0; i < sheet.length; i++) {
        if (sheet[i].sourceRef === sourceRef) { sheetSegIndexes.push(i); }
      }
      Object.entries(related_obj).map(([key, valueList]) => {
        const flattenedValues = valueList.reduce((accum, curr) => accum.concat(curr), []);
        for (let i of sheetSegIndexes) {
          if (key === 'links') {
            sheet[i][key] = flattenedValues;
          } else {
            if (!sheet[i].relatedWOLinks) { sheet[i].relatedWOLinks = []; }
            sheet[i].relatedWOLinks[key] = flattenedValues;
          }
        }
      });
      return sheet;
    },
    addRelatedToText: function(text, related) {
      const related_obj = Sefaria.links.organizeRelatedBySegment(related);
      return text.map((seg,i) => ({
        ...seg,
        links: related_obj.links[i] || [],
        relatedWOLinks: {
          ...Object.keys(related_obj).filter(x => x !== 'links').reduce((obj, x) => {
            obj[x] = related_obj[x][i] || [];
            return obj;
          }, {}),
        },
      }));
    },
    loadLinkData: function(ref, pos, resolveClosure, rejectClosure, runNow) {
      const parseData = async function(data) {
        let result;
        try {
          result = data.fromAPI ? data.result : Sefaria.textFromRefData(data);
        } catch (e) {
          crashlytics().recordError(new Error(`loadLinkData failed to load ${data.requestedRef}`));
        }
        let prev = Sefaria.links._linkContentLoadingStack.shift();
        //delete Sefaria.links._linkContentLoadingHash[prev.ref];
        //console.log("Removing from queue:",prev.ref,"Length:",Sefaria.links._linkContentLoadingStack.length);
        if (Sefaria.links._linkContentLoadingStack.length > 0) {
          let next = Sefaria.links._linkContentLoadingStack[0]; //Sefaria.links._linkContentLoadingStack.length-1
          Sefaria.links.loadLinkData(next.ref, next.pos, null, null, true)
                          .then(next.resolveClosure)
                          .catch(next.rejectClosure);
        }
        if (result) {
          return result;
        } else {
          throw result;
        }
      };

      if (!runNow) {
        //console.log("Putting in queue:",ref,"Length:",Sefaria.links._linkContentLoadingStack.length);
        Sefaria.links._linkContentLoadingStack.push({
                                                      "ref":ref,
                                                      "pos":pos,
                                                      "resolveClosure":resolveClosure,
                                                      "rejectClosure":rejectClosure
                                                    });
      }
      if (Sefaria.links._linkContentLoadingStack.length == 1 || runNow) {
        //console.log("Starting to load",ref);
        return Sefaria.data(ref, true).then(parseData);
      } else {
        //console.log("Rejecting", ref);
        return new Promise(function(resolve, reject) {
          reject('inQueue');
        })
      }

    },
    linkSummary: function(sectionRef, links=[], textLanguage) {
      // Returns a categories and sorted summary of `links` with `sectionRef` (used to show empty commentators).
      return new Promise(function(resolve, reject) {
        // Returns an ordered array summarizing the link counts by category and text
        // Takes an array of links which are of the form { "category", "sourceHeRef", "sourceRef", "textTitle"}
        var summary = {"All": {count: 0, books: {}, hasEn: false}, "Commentary": {count: 0, books: {}, hasEn: false}};

        // Process tempLinks if any
        for (let link of links) {
          if (!link.category) {
            link.category = 'Other';
          }
          // Count Category
          if (link.category in summary) {
            //TODO summary[link.category].count += 1
          } else {
            summary[link.category] = {count: 1, books: {}};
          }
          //TODO summary["All"].count += 1;

          var category = summary[link.category];
          // Count Book
          const title = link.collectiveTitle || link.textTitle;
          if (!!category.books[title]) {
            category.books[title].refSet.add(link.sourceRef);
            category.books[title].heRefSet.add(link.sourceHeRef);
            category.books[title].hasEn = category.books[title].hasEn || link.sourceHasEn;
          } else {
            const tempIndex = Sefaria.index(link.textTitle);
            if (!tempIndex) { continue; }
            category.books[title] =
            {
                count:             1,
                title:             title,
                heTitle:           link.heCollectiveTitle || tempIndex.heTitle,
                collectiveTitle:   link.collectiveTitle,
                heCollectiveTitle: link.heCollectiveTitle,
                category:          link.category,
                refSet:            new Set([link.sourceRef]), // make sure refs are unique here
                heRefSet:          new Set([link.sourceHeRef]),
                hasEn:             link.sourceHasEn,
            };
          }
        }

        //Add zero commentaries
        let commentatorList = Sefaria.commentatorListBySection(sectionRef);
        if (commentatorList) {
          let commentaryBooks = summary["Commentary"].books;
          for (let i = 0; i < commentatorList.en.length; i++) {
            let commEn = commentatorList.en[i];
            let commHe = commentatorList.he[i];
            if (!commentaryBooks[commEn]) {
              commentaryBooks[commEn] =
              {
                count:    0,
                title:    commEn,
                heTitle:  commHe,
                category: "Commentary",
                refSet:   new Set(),
                heRefSet: new Set(),
                hasEn:    false,
              }
            }
          }
        }

        // Convert object into ordered list
        const topByCategory = {
          "Commentary": ["Rashi", "Ibn Ezra", "Ramban","Tosafot"]
        };
        let summaryList = Object.entries(summary).map(([category, categoryData]) => {
          categoryData.category = category;
          categoryData.refList = [];
          categoryData.heRefList = [];
          // Sort the books in the category
          categoryData.books = Object.values(categoryData.books).sort((a, b) => {
            // First sort by predefined "top"
            let top = topByCategory[categoryData.category] || [];
            let aTop = top.indexOf(a.title);
            let bTop = top.indexOf(b.title);
            if (aTop !== -1 || bTop !== -1) {
              aTop = aTop === -1 ? 999 : aTop;
              bTop = bTop === -1 ? 999 : bTop;
              return aTop < bTop ? -1 : 1;
            }
            // Then sort alphabetically
            if (textLanguage !== 'hebrew'){
              return (a.title > b.title) ? 1 : -1;
            }
            // else hebrew
            return (a.heTitle > b.heTitle) ? 1 : -1;
          });
          return categoryData;
        });

        // Count all refs in each book and cat
        let allRefs = [];
        let allHeRefs = [];
        const allBooks = [];
        let otherCommentaryCount = 0;
        let commentaryCat;
        for (let cat of summaryList) {
          for (let book of cat.books) {
            const [bookRefList, bookHeRefList] = Sefaria.links.sortRefsBySections(Array.from(book.refSet), Array.from(book.heRefSet), book.title);
            delete book.refSet;
            delete book.heRefSet;
            book.refList = bookRefList;
            book.heRefList = bookHeRefList;
            if (book.refList.length !== book.heRefList.length) { console.log("MAJOR ISSUES!!", book.refList)}
            book.count = book.refList.length;
            cat.refList = cat.refList.concat(bookRefList);
            cat.heRefList = cat.heRefList.concat(bookHeRefList);
            cat.hasEn = cat.hasEn || book.hasEn;
            allRefs = allRefs.concat(bookRefList);
            allHeRefs = allHeRefs.concat(bookHeRefList);
            allBooks.push(book);
          }
          cat.count = cat.refList.length;
          if (['Quoting Commentary', 'Modern Commentary'].indexOf(cat.category) !== -1) {
            otherCommentaryCount += cat.count;
          }
          if (cat.category === 'Commentary') { commentaryCat = cat; }
        }
        // aggregate total count of quoting + modern + normal commentary
        commentaryCat.totalCount = commentaryCat.count + otherCommentaryCount;

        // Sort the categories
        const order = ["Commentary", "Targum", "byCatOrder", "All"];
        const indexByCatOrder = order.indexOf("byCatOrder");
        summaryList.sort(function(a, b) {
          var indexA = order.indexOf(a.category) != -1 ? order.indexOf(a.category) : indexByCatOrder;
          var indexB = order.indexOf(b.category) != -1 ? order.indexOf(b.category) : indexByCatOrder;

          if (indexA === indexByCatOrder && indexB === indexByCatOrder) {
            const aOrder = Sefaria.topLevelCategories.indexOf(a.category);
            const bOrder = Sefaria.topLevelCategories.indexOf(b.category);
            if (aOrder === -1 && bOrder === -1) {
              if (a.category < b.category) { return -1; }
              if (a.category > b.category) { return  1; }
              return 0;
            }
            if (aOrder === -1) { return 1; }
            if (bOrder === -1) { return -1; }

            return aOrder - bOrder;
          }

          return indexA - indexB;

        });

        // Attach data to "All" category in last position
        summaryList[summaryList.length-1].refList = allRefs;
        summaryList[summaryList.length-1].heRefList = allHeRefs;
        summaryList[summaryList.length-1].books = allBooks;
        summaryList[summaryList.length-1].count = allRefs.length;

        // Remove "Commentary" section if it is empty or only contains greyed out items
        if (summaryList[0].books.length == 0) { summaryList = summaryList.slice(1); }

        // Remove "All" section if it's count is zero
        if (summaryList[summaryList.length-1].count == 0) { summaryList = summaryList.slice(0, -1); }
        resolve(summaryList);
      });

    },
    sortRefsBySections(enRefs, heRefs, title) {
      const biRefList = Sefaria.util.zip([enRefs, heRefs]);
      biRefList.sort((a,b) => {
        try {
          const aSections = a[0].substring(title.length+1).trim().split(':');
          const bSections = b[0].substring(title.length+1).trim().split(':');
          if (aSections.length !== bSections.length) { return 0; }  // not comparable
          for (let iSec = 0; iSec < aSections.length; iSec++) {
            const aInt = parseInt(aSections[iSec]);
            const bInt = parseInt(bSections[iSec]);
            if (!isNaN(aInt) && !isNaN(bInt) && aInt !== bInt) { return aInt - bInt; }
          }
          return 0;
        } catch (e) {
          console.log(e);
          return 0;
        }
      });
      return biRefList.reduce((accum, item) => [accum[0].concat([item[0]]), accum[1].concat([item[1]])], [[],[]]);
    },
    aggregateTopics: function(topics) {
      const topicsObj = {};
      if (!topics) { return null; }  // _refTopicLinks will have an empty array for ref if ref's topics were loaded
      for (let tempTopic of topics) {
        if (!topicsObj[tempTopic.topic]) {
          tempTopic.order = tempTopic.order || {};
          tempTopic.dataSources = {};
          topicsObj[tempTopic.topic] = tempTopic;
        }
        // aggregate dataSources for display in tooltip
        topicsObj[tempTopic.topic].dataSources[tempTopic.dataSource.slug] = tempTopic.dataSource;
      }
      return Object.values(topicsObj).sort((a, b) => b.order.pr - a.order.pr);
    },
    topicsCount: function(topics) {
      const aggregatedTopics = Sefaria.links.aggregateTopics(topics);
      return aggregatedTopics && aggregatedTopics.length;
    },
  },
  track: {
      // Helper functions for event tracking (with Google Analytics and Mixpanel)
      init: function() {
        analytics().setAnalyticsCollectionEnabled(true);
      },

      setScreen: function(screen_name, screen_class) {
        analytics().logScreenView({ screen_class, screen_name });
      },

      event: function(event, params) {
        analytics().logEvent(event, params)
      },

      pageview: function(page, customDimensions, contentGroups) {

        // TODO: This seems to fire every time a new ref comes in or out of view and doesn't seem to give super rich data is this by design?


        /*
        if (contentGroups) {
          for (let contGroup of Object.keys(contentGroups)) {
            //Sefaria.track._tracker.trackContentGroup(parseInt(contGroup), contentGroups.contGroup);
          }
        }

        if (customDimensions) {
          Sefaria.track._tracker.trackScreenViewWithCustomDimensionValues(page, customDimensions);
        } else {
          Sefaria.track._tracker.trackScreenView(page);
        }

         */
      },
    }
};

Sefaria.util = {
  localeDate: (dateString, interfaceLanguage) => {
    // takes dateString (usually generated from Python datetime object) and returns a human readable string depending on interfaceLang
    const locale = interfaceLanguage === 'english' ? 'en-US' : 'iw-IL';
    const dateOptions = {year: 'numeric', month: 'short', day: 'numeric'};
    return (new Date(dateString)).toLocaleDateString(locale, dateOptions).replace(',', '');  // remove comma from english date
  },
  makeCancelable: (promise) => {
    let hasCanceled_ = false;

    const wrappedPromise = new Promise((resolve, reject) => {
      promise.then(
        val => hasCanceled_ ? reject({isCanceled: true}) : resolve(val),
        error => hasCanceled_ ? reject({isCanceled: true}) : reject(error)
      );
    });

    return {
      promise: wrappedPromise,
      cancel() { hasCanceled_ = true; },
    };
  },
  zip: rows=>rows[0].map((_,c)=>rows.map(row=>row[c])),

  PROCEDURAL_PROMISE_INTERRUPT: "INTERRUPT",
  procedural_promise_on_array: async function(array, promise, extra_params) {
    // run `promise` for each item of `array` one-by-one. useful for making multiple API calls that don't trip over each other
    // extra_params should be passed as an array
    for (let item of array) {
      try {
        await promise(item, ...extra_params);
      } catch (e) {
        if (e === Sefaria.util.PROCEDURAL_PROMISE_INTERRUPT) { break; }
        continue;
      }
    }
  },
  get_menu_language: function(interfaceLanguage, textLanguage) {
    //menu language is no longer set explicitly
    //Instead, it is set like this
    return interfaceLanguage == 'hebrew' || textLanguage == 'hebrew' ? 'hebrew' : 'english';
  },
  objectHasNonNullValues: function(obj) {
    return !!obj && Object.keys(obj).length !== 0 && Object.values(obj).reduce((accum, curr) => accum || !!curr, false);
  },
  object_equals: function(a, b) {
    // simple object equality assuming values are primitive. see here
    // http://adripofjavascript.com/blog/drips/object-equality-in-javascript.html
    if ((typeof a) !== (typeof b))      { return false; }
    if ((a === null && b !== null) || (a !== null && b === null))
                                        { return false; }
    if ((a === null && b === null) || (a === undefined && b === undefined))
                                        { return true; }
    const aProps = Object.getOwnPropertyNames(a);
    const bProps = Object.getOwnPropertyNames(b);
    if (aProps.length != bProps.length) { return false; }
    for (let propName of aProps) {
      if (a[propName] !== b[propName])  { return false; }
    }
    return true;
  },
  timeoutPromise: function(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },
  epoch_time() {
    // get current epoch time in UTC
    // silly but thus is JS
    // see: https://stackoverflow.com/a/6777470/4246723
    const now = new Date();
    const nowUTC =  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
                             now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds());
    return Math.round(nowUTC/1000);
  },
  cleanSheetHTML(html) {
    if (!html) { return ""; }
    html = html.replace(/\u00a0/g, ' ').replace(/&nbsp;/g, ' ').replace(/(\r\n|\n|\r)/gm, "");
    const cleanAttributes = {  // used to not allow any attributes on Android. Removed because it wasn't clear why we did this although an old commit claims these attributes caused crashing.
              a: [ 'href', 'name', 'target' ],
              img: [ 'src' ],
              p: ['style'],
              span: ['style'],
              div: ['style'],
              td: ['colspan'],
            };
    const clean = sanitizeHtml(html, {
            allowedTags: [ 'blockquote', 'p', 'a', 'ul', 'ol',
              'nl', 'li', 'b', 'i', 'strong', 'em', 'small', 'big', 'span', 'strike', 'hr', 'br', 'div',
              'table', 'thead', 'caption', 'tbody', 'tr', 'th', 'td', 'pre', 'sup' ],
            allowedAttributes: cleanAttributes,
            allowedClasses: {
             'sup': ['nechama'],
            },
            allowedStyles: {
              '*': {
                'color': [/^\#(0x)?[0-9a-f]+$/i, /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/],
                'background-color': [/^\#(0x)?[0-9a-f]+$/i, /^rgb(?!\(\s*255\s*,\s*255\s*,\s*255\s*\))\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/],
                'text-align': [/^left$/, /^right$/, /^center$/],
              },
            },
            exclusiveFilter: function(frame) {
                return frame.tag === 'p' && !frame.text.trim();
            } //removes empty p tags  generated by ckeditor...

          });
    return clean;
  },
  filterOutItags: function(text) {
    // right now app is not displaying i-tags properly. interim solution is to not display them at all
    //NOTE need to be careful about nested i-tags
    try {
      //text = text.replace(/<sup>[^<]*<\/sup>\s*<i +class=["']footnote["']>(?:[^<]*|(?:[^<]*<i>[^<]*<\/i>[^<]*|[^<]*<br>[^<]*)+)<\/i>/gm, '');
      //text = text.replace(/(?:\s?<i [^<]*><\/i>\s?)+/g, ' ').trim();  // remove rest of i-tags which add unnecessary spaces
      return text;
    } catch (e) {
      //in case segment is not string (which should not happen but does)
      return text;
    }
  },
  hebrewInEnglish: function(text, whatToReturn) {
    const regEx = /(^|[\s\[\]().,;:*?!\-"'])((?:[\u0591-\u05c7\u05d0-\u05ea]+[()\[\]\s'"\u05f3\u05f4]{0,2})+)([<>\[\]().,;:*?!\-'"\s]|$)/g
    if (whatToReturn == "string") {
      // wrap all Hebrew strings with <hediv>
      return text.replace(regEx, '$1<hediv>$2</hediv>$3');
    }
    else if (whatToReturn == "list") {
      return text.split(regEx)
    }
  },
  getDisplayableHTML: function(text, lang, isSheet) {
    if (isSheet) { text = Sefaria.util.cleanSheetHTML(text); }
    text = Sefaria.util.filterOutItags(text);
    text = text.replace(/\u200e/g, '');  // remove invisible LTR mark that can ruin display
    if (lang === 'english') {
      return `<endiv>\u2066${Sefaria.util.hebrewInEnglish(text, 'string')}</endiv>`;
    }
    return `<hediv>${text}</hediv>`;
  },
  applyVocalizationSettings: function(text, vocalization, vowelToggleAvailable) {
    if (vowelToggleAvailable === VOCALIZATION.NONE || vocalization === VOCALIZATION.TAAMIM_AND_NIKKUD) { return text; } 
    const nre = /(?:[\u0591-\u05af\u05bd\u05bf\u05c4\u05c5\u200d]|\s\u05c0)/g;
    const cnre = /(?:[\u0591-\u05bd\u05bf\u05c1-\u05c5\u05c7\u200d]|\s\u05c0)/g;
    const strip_text_re = (vocalization == VOCALIZATION.NIKKUD) ? nre : cnre;
    return text.replace(strip_text_re, "");
  },
  openFileInSources: async function(filename) {
    const isIOS = Platform.OS === 'ios';
    let fileData;
    let useLib = false;
    const libPath = `${FileSystem.documentDirectory}/library/${filename}`;
    const sourcePath = isIOS ? encodeURI(`${FileSystem.bundleDirectory}/sources/${filename}`) : `${FileSystem.bundleDirectory}sources/${filename}`;
    const libExists = await fileExists(libPath);
    if (libExists) {
      // check date of each file and choose latest
      const libStats = await FileSystem.getInfoAsync(libPath);
      useLib = libStats.modificationTime * 1000 > Sefaria.lastAppUpdateTime;
    }
    if (useLib) {
      fileData = await Sefaria._loadJSON(libPath);
    } else {  //if (isIOS) {
      fileData = await Sefaria._loadJSON(sourcePath);
    } //else {
      // android
      // fileData = await FileSystem.readAsStringAsync(sourcePath);
      // fileData = JSON.parse(fileData);
    //}
    return fileData;
  },
  getISOCountryCode: function() {
    return new Promise((resolve, reject) => {
      fetch('http://ip-api.com/json')
      .then(result=>result.json())
      .then(json=>resolve(json.countryCode));
    });
  },
  parseURLhost: function(url) {
    //thanks rvighne! https://stackoverflow.com/questions/736513/how-do-i-parse-a-url-into-hostname-and-path-in-javascript
    const u = new URL(url);
    return u.hostname;
  },
  _licenseMap: {
    "Public Domain": "http://en.wikipedia.org/wiki/Public_domain",
    "CC0": "http://creativecommons.org/publicdomain/zero/1.0/",
    "CC-BY": "http://creativecommons.org/licenses/by/3.0/",
    "CC-BY-SA": "http://creativecommons.org/licenses/by-sa/3.0/",
    "CC-BY-NC": "https://creativecommons.org/licenses/by-nc/4.0/"
  },
  getLicenseURL: function(license) {
      return Sefaria.util._licenseMap[license];
  },
  clone: function(obj) {
    // Handle the 3 simple types, and null or undefined
    if (null == obj || "object" != typeof obj) return obj;

    // Handle Date
    if (obj instanceof Date) {
      const copy = new Date();
      copy.setTime(obj.getTime());
      return copy;
    }
    if (typeof obj.clone === 'function') {
      return obj.clone();
    }
    // Handle Array
    if (obj instanceof Array) {
      const copy = [];
      const len = obj.length;
      for (let i = 0; i < len; ++i) {
        copy[i] = Sefaria.util.clone(obj[i]);
      }
      return copy;
    }

    // Handle Object
    if (obj instanceof Object) {
      const copy = {};
      for (let attr in obj) {
        if (obj.hasOwnProperty(attr)) copy[attr] = Sefaria.util.clone(obj[attr]);
      }
      return copy;
    }

    throw new Error("Unable to copy obj! Its type isn't supported.");
  },
  inArray: function(needle, haystack) {
    if (!haystack) {
      return -1
    } //For parity of behavior w/ JQuery inArray
    var index = -1;
    for (var i = 0; i < haystack.length; i++) {
      if (haystack[i] === needle) {
        index = i;
        break;
      }
    }
    return index;
  },
  compareArrays: function(a, b) {
      if (a.length != b.length) return false;
      for (var i = 0; i < b.length; i++) {
          if (a[i] !== b[i]) return false;
      }
      return true;
  },
  getTextLanguageWithContent: function(lang, en, he) {
    // Returns a language that has content in it give strings `en` and `he`, with a preference for `lang`.
    let newLang = lang;
    const hasEn = (typeof en === "string") && en.replace(/<.+?>/g,'').replace(/[\u200e\u2066]/g, '').trim() != "";
    const hasHe = (typeof he === "string") && he.replace(/<.+?>/g,'').replace(/[\u200e\u2066]/g, '').trim() != "";
    if (newLang == "bilingual") {
      if (hasEn && !hasHe) {
        newLang = "english";
      } else if (!hasEn) newLang  = "hebrew";
    }

    if (newLang == "english")
      newLang = hasEn ? "english" : "hebrew";
    else if (newLang == "hebrew")
      newLang = hasHe || !hasEn ? "hebrew" : "english"; //make sure when there's no content it's hebrew
    return newLang;
  },
  regexEscape: function(s) {
    return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  },
  stripHtml: function(rawHTML) {
    return rawHTML.replace(/<\/?[^>]+(>|$)/g, "").replace(/\s+/g, ' ').replace(/&amp;/g,"&").replace(/&nbsp;/g, ' ');
  },
  lightenDarkenColor: function(col, amt) {
    var usePound = false;
    if (col[0] == "#") {
      col = col.slice(1);
      usePound = true;
    }
    var num = parseInt(col,16);
    var r = (num >> 16) + amt;
    if (r > 255) r = 255;
    else if  (r < 0) r = 0;
    var b = ((num >> 8) & 0x00FF) + amt;
    if (b > 255) b = 255;
    else if  (b < 0) b = 0;
    var g = (num & 0x0000FF) + amt;
    if (g > 255) g = 255;
    else if (g < 0) g = 0;
    let colorString = (g | (b << 8) | (r << 16)).toString(16);
    while (colorString.length < 6) {
      colorString = "0" + colorString;
    }
    return (usePound?"#":"") + colorString;
  },
  removeHtml: function(str) {
    return str.replace(/<[^>]+>/g, '');
  },
  translateISOLanguageCode(code) {
    //takes two-letter ISO 639.2 code and returns full language name
    const codeMap = {
      "en": "english",
      "he": "hebrew",
      "yi": "yiddish",
      "fi": "finnish",
      "pt": "portuguese",
      "es": "spanish",
      "fr": "french",
      "de": "german",
      "ar": "arabic",
      "it": "italian",
      "pl": "polish",
      "ru": "russian",
      "eo": "esparanto",
      "fa": "farsi",
    };
    return codeMap[code.toLowerCase()];
  }
};

Sefaria.api = Api;

Sefaria.history = History;

Sefaria.hebrew = {
  hebrewNumerals: {
    "\u05D0": 1,
    "\u05D1": 2,
    "\u05D2": 3,
    "\u05D3": 4,
    "\u05D4": 5,
    "\u05D5": 6,
    "\u05D6": 7,
    "\u05D7": 8,
    "\u05D8": 9,
    "\u05D9": 10,
    "\u05D8\u05D5": 15,
    "\u05D8\u05D6": 16,
    "\u05DB": 20,
    "\u05DC": 30,
    "\u05DE": 40,
    "\u05E0": 50,
    "\u05E1": 60,
    "\u05E2": 70,
    "\u05E4": 80,
    "\u05E6": 90,
    "\u05E7": 100,
    "\u05E8": 200,
    "\u05E9": 300,
    "\u05EA": 400,
    "\u05EA\u05E7": 500,
    "\u05EA\u05E8": 600,
    "\u05EA\u05E9": 700,
    "\u05EA\u05EA": 800,
    1: "\u05D0",
    2: "\u05D1",
    3: "\u05D2",
    4: "\u05D3",
    5: "\u05D4",
    6: "\u05D5",
    7: "\u05D6",
    8: "\u05D7",
    9: "\u05D8",
    10: "\u05D9",
    15: "\u05D8\u05D5",
    16: "\u05D8\u05D6",
    20: "\u05DB",
    30: "\u05DC",
    40: "\u05DE",
    50: "\u05E0",
    60: "\u05E1",
    70: "\u05E2",
    80: "\u05E4",
    90: "\u05E6",
    100: "\u05E7",
    200: "\u05E8",
    300: "\u05E9",
    400: "\u05EA",
    500: "\u05EA\u05E7",
    600: "\u05EA\u05E8",
    700: "\u05EA\u05E9",
    800: "\u05EA\u05EA",
    900: "\u05EA\u05EA\u05E7",
    1000: "\u05EA\u05EA\u05E8",
    1100: "\u05EA\u05EA\u05E9",
    1200: "\u05EA\u05EA\u05EA"
  },
  decodeHebrewNumeral: function(h) {
    // Takes a string representing a Hebrew numeral and returns it integer value.
    var values = Sefaria.hebrew.hebrewNumerals;

    if (h === values[15] || h === values[16]) {
      return values[h];
    }

    var n = 0
    for (c in h) {
      n += values[h[c]];
    }

    return n;
  },
  encodeHebrewNumeral: function(n) {
    // Takes an integer and returns a string encoding it as a Hebrew numeral.
    n = parseInt(n);
    if (n >= 1300) {
      return n;
    }

    var values = Sefaria.hebrew.hebrewNumerals;

    var heb = "";
    if (n >= 100) {
      var hundreds = n - (n % 100);
      heb += values[hundreds];
      n -= hundreds;
    }
    if (n === 15 || n === 16) {
      // Catch 15/16 no matter what the hundreds column says
      heb += values[n];
    } else {
      if (n >= 10) {
        var tens = n - (n % 10);
        heb += values[tens];
        n -= tens;
      }
      if (n > 0) {
        if (!values[n]) {
            return undefined
        }
        heb += values[n];
      }
    }

    return heb;
  },
  encodeHebrewDaf: function(daf, form) {
    // Ruturns Hebrew daf strings from "32b"
    var form = form || "short"
    var n = parseInt(daf.slice(0,-1));
    var a = daf.slice(-1);
    if (form === "short") {
      a = {a: ".", b: ":"}[a];
      return Sefaria.hebrew.encodeHebrewNumeral(n) + a;
    }
    else if (form === "long"){
      a = {a: 1, b: 2}[a];
      return Sefaria.hebrew.encodeHebrewNumeral(n) + " " + Sefaria.hebrew.encodeHebrewNumeral(a);
    }
  },
  stripNikkud: function(rawString) {
    return rawString.replace(/[\u0591-\u05C7]/g,"");
  },
  isHebrew: function(text) {
    // Returns true if text is (mostly) Hebrew
    // Examines up to the first 60 characters, ignoring punctuation and numbers
    // 60 is needed to cover cases where a Hebrew text starts with 31 chars like: <big><strong>גמ׳</strong></big>
    var heCount = 0;
    var enCount = 0;
    var punctuationRE = /[0-9 .,'"?!;:\-=@#$%^&*()/<>]/;

    for (var i = 0; i < Math.min(60, text.length); i++) {
      if (punctuationRE.test(text[i])) { continue; }
      if ((text.charCodeAt(i) > 0x590) && (text.charCodeAt(i) < 0x5FF)) {
        heCount++;
      } else {
        enCount++;
      }
    }

    return (heCount >= enCount);
  },
  containsHebrew: function(text) {
    // Returns true if there are any Hebrew characters in text
    for (var i = 0; i < text.length; i++) {
      if ((text.charCodeAt(i) > 0x590) && (text.charCodeAt(i) < 0x5FF)) {
        return true;
      }
    }
    return false;
  },
  hebrewPlural: function(s) {
    var known = {
      "Daf":      "Dappim",
      "Mitzvah":  "Mitzvot",
      "Mitsva":   "Mitzvot",
      "Mesechet": "Mesechtot",
      "Perek":    "Perokim",
      "Siman":    "Simanim",
      "Seif":     "Seifim",
      "Se'if":    "Se'ifim",
      "Mishnah":  "Mishnayot",
      "Mishna":   "Mishnayot",
      "Chelek":   "Chelekim",
      "Parasha":  "Parshiot",
      "Parsha":   "Parshiot",
      "Pasuk":    "Psukim",
      "Midrash":  "Midrashim",
      "Aliyah":   "Aliyot"
    };

    return (s in known ? known[s] : s + "s");
  },
  intToDaf: function(i) {
    i += 1;
    daf = Math.ceil(i/2);
    return daf + (i%2 ? "a" : "b");
  },
  dafToInt: function(daf) {
    amud = daf.slice(-1)
    i = parseInt(daf.slice(0, -1)) - 1;
    i = amud == "a" ? i * 2 : i*2 +1;
    return i;
  }
};

Sefaria.terms = {}; // TODO ideally we include a dump of all terms as offline JSON file. this is a placekeeper

Sefaria.hebrewCategory = function(cat) {
  // Returns a string translating `cat` into Hebrew.
  if (Sefaria.hebrewCategories) {
    // pregenerated hebrew categories from dump
    if (cat in Sefaria.hebrewCategories) {
      return Sefaria.hebrewCategories[cat];
    }
  }
  const pseudoCategories = {
    "Commentary": "מפרשים",
    "Quoting Commentary": "פרשנות מצטטת",
    "Modern Commentary": "פרשנות מודרנית",
    "Other": "אחר",
    "Sheets": "דפי מקורות",
    "Notes": "הערות",
    "Community": "קהילה",
    "All": "הכל",
  };
  return cat in pseudoCategories ? pseudoCategories[cat] : cat;
};

Sefaria.hebrewSectionName = function(name) {
  sectionNames = {
    "Chapter":          "פרק",
    "Chapters":         "פרקים",
    "Perek":            "פרק",
    "Line":             "שורה",
    "Negative Mitzvah": "מצות לא תעשה",
    "Positive Mitzvah": "מצות עשה",
    "Negative Mitzvot": "מצוות לא תעשה",
    "Positive Mitzvot": "מצוות עשה",
    "Daf":              "דף",
    "Paragraph":        "פסקה",
    "Parsha":           "פרשה",
    "Parasha":          "פרשה",
    "Parashah":         "פרשה",
    "Seif":             "סעיף",
    "Se'if":            "סעיף",
    "Siman":            "סימן",
    "Section":          "חלק",
    "Verse":            "פסוק",
    "Sentence":         "משפט",
    "Sha'ar":           "שער",
    "Gate":             "שער",
    "Comment":          "פירוש",
    "Phrase":           "ביטוי",
    "Mishna":           "משנה",
    "Chelek":           "חלק",
    "Helek":            "חלק",
    "Year":             "שנה",
    "Masechet":         "מסכת",
    "Massechet":        "מסכת",
    "Letter":           "אות",
    "Halacha":          "הלכה",
    "Piska":            "פסקה",
    "Seif Katan":       "סעיף קטן",
    "Se'if Katan":      "סעיף קטן",
    "Volume":           "כרך",
    "Book":             "ספר",
    "Shar":             "שער",
    "Seder":            "סדר",
    "Part":             "חלק",
    "Pasuk":            "פסוק",
    "Sefer":            "ספר",
    "Teshuva":          "תשובה",
    "Teshuvot":         "תשובות",
    "Tosefta":          "תוספתא",
    "Halakhah":         "הלכה",
    "Kovetz":           "קובץ",
    "Path":             "נתיב",
    "Parshah":          "פרשה",
    "Midrash":          "מדרש",
    "Mitzvah":          "מצוה",
    "Tefillah":         "תפילה",
    "Torah":            "תורה",
    "Perush":           "פירוש",
    "Peirush":          "פירוש",
    "Aliyah":           "עלייה",
    "Tikkun":           "תיקון",
    "Tikkunim":         "תיקונים",
    "Hilchot":          "הילכות",
    "Topic":            "נושא",
    "Contents":         "תוכן",
    "Article":          "סעיף",
    "Shoresh":          "שורש",
    "Story":            "סיפור",
    "Remez":            "רמז"
  };
  return name in sectionNames ? sectionNames[name] : name;
};


Sefaria.palette = {
  colors: {
    darkteal: "#004e5f",
    raspberry: "#7c406f",
    green: "#5d956f",
    paleblue: "#9ab8cb",
    blue: "#4871bf",
    orange: "#cb6158",
    lightpink: "#c7a7b4",
    darkblue: "#073570",
    darkpink: "#ab4e66",
    lavender: "#7f85a9",
    yellow: "#ccb479",
    purple: "#594176",
    lightblue: "#5a99b7",
    lightgreen: "#97b386",
    red: "#802f3e",
    teal: "#00827f",
    system: "#142b51",
    palegreen: "#B8D4D3",
    lightbg:   "#B8D4D3",
    tan:       "#D4896C",
  }
};
Sefaria.palette.categoryColors = {
  "All":                Sefaria.palette.colors.system,
  "Commentary":         Sefaria.palette.colors.blue,
  "Tanakh":             Sefaria.palette.colors.darkteal,
  "Midrash":            Sefaria.palette.colors.green,
  "Mishnah":            Sefaria.palette.colors.lightblue,
  "Talmud":             Sefaria.palette.colors.yellow,
  "Halakhah":           Sefaria.palette.colors.red,
  "Kabbalah":           Sefaria.palette.colors.purple,
  "Philosophy":         Sefaria.palette.colors.lavender,  // to delete
  "Jewish Thought":     Sefaria.palette.colors.lavender,
  "Liturgy":            Sefaria.palette.colors.darkpink,
  "Tosefta":            Sefaria.palette.colors.teal,
  "Tanaitic":           Sefaria.palette.colors.teal,  // to delete
  "Parshanut":          Sefaria.palette.colors.paleblue,
  "Chasidut":           Sefaria.palette.colors.lightgreen,
  "Musar":              Sefaria.palette.colors.raspberry,
  "Responsa":           Sefaria.palette.colors.orange,
  "Apocrypha":          Sefaria.palette.colors.lightpink,
  "Second Temple":      Sefaria.palette.colors.lightpink,   // to delete
  "Other":              Sefaria.palette.colors.darkblue,
  "Quoting Commentary": Sefaria.palette.colors.orange,
  "Sheets":             Sefaria.palette.colors.darkblue,
  "Community":          Sefaria.palette.colors.raspberry,
  "Targum":             Sefaria.palette.colors.lavender,
  "Modern Works":       Sefaria.palette.colors.palegreen,  // to delete
  "Modern Commentary":  Sefaria.palette.colors.palegreen,
  "More":               Sefaria.palette.colors.darkblue,
  "Modern Commentary":  Sefaria.palette.colors.lightbg,
  "Reference":          Sefaria.palette.colors.tan,
};
Sefaria.palette.categoryColor = function(cat) {
  if (cat in Sefaria.palette.categoryColors) {
    return Sefaria.palette.categoryColors[cat];
  }
  return Sefaria.palette.categoryColors["Other"];
};
Sefaria.palette.refColor = ref => Sefaria.palette.categoryColor(Sefaria.categoryForRef(ref));
Sefaria.search = new Search('https://www.sefaria.org', 'text', 'sheet');

Array.prototype.stableSort = function(cmp) {
  cmp = !!cmp ? cmp : (a, b) => {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  };
  let stabilizedThis = this.map((el, index) => [el, index]);
  let stableCmp = (a, b) => {
    let order = cmp(a[0], b[0]);
    if (order != 0) return order;
    return a[1] - b[1];
  }
  stabilizedThis.sort(stableCmp);
  for (let i=0; i<this.length; i++) {
    this[i] = stabilizedThis[i][0];
  }
  return this;
}

//for debugging. from https://gist.github.com/zensh/4975495
Sefaria.memorySizeOf = function (obj) {
    var bytes = 0;

    function sizeOf(obj) {
        if(obj !== null && obj !== undefined) {
            switch(typeof obj) {
            case 'number':
                bytes += 8;
                break;
            case 'string':
                bytes += obj.length * 2;
                break;
            case 'boolean':
                bytes += 4;
                break;
            case 'object':
                var objClass = Object.prototype.toString.call(obj).slice(8, -1);
                if(objClass === 'Object' || objClass === 'Array') {
                    for(var key in obj) {
                        if(!obj.hasOwnProperty(key)) continue;
                        sizeOf(obj[key]);
                        sizeOf(key);
                    }
                } else bytes += obj.toString().length * 2;
                break;
            }
        }
        return bytes;
    };

    function formatByteSize(bytes) {
        if(bytes < 1024) return bytes + " bytes";
        else if(bytes < 1048576) return(bytes / 1024).toFixed(3) + " KiB";
        else if(bytes < 1073741824) return(bytes / 1048576).toFixed(3) + " MiB";
        else return(bytes / 1073741824).toFixed(3) + " GiB";
    };

    return formatByteSize(sizeOf(obj));
};
export default Sefaria;
