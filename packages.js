import { AsyncStorage, AlertIOS } from 'react-native';
const RNFS = require('react-native-fs');
import strings from './LocalizedStrings';

const Packages = {
  available: null,
  selected: null,
  titleToPackageMap: {},
  newToPackages: false, // true if you've never used the packages feature yet
  _load: function() {
    return Promise.all([
      new Promise((resolve, reject) => {
        RNFS.exists(RNFS.DocumentDirectoryPath + "/library/packages.json")
        .then(exists => {
          const pkgPath = exists ? (RNFS.DocumentDirectoryPath + "/library/packages.json") :
                                      (RNFS.MainBundlePath + "/sources/packages.json");
          console.log(exists, pkgPath);
          Sefaria._loadJSON(pkgPath).then(function(data) {
            Sefaria.packages.available = data;
            for (pkgObj of data) {
              if (!!pkgObj.indexes) {
                for (i of pkgObj.indexes) {
                  if (!!Sefaria.packages.titleToPackageMap[i]) {
                    Sefaria.packages.titleToPackageMap[i].push(pkgObj.en);
                  } else {
                    Sefaria.packages.titleToPackageMap[i] = [pkgObj.en];
                  }
                }
              }
            }
            resolve();
          });
        });
      }),
      AsyncStorage.getItem("packagesSelected").then(function(data) {
        Sefaria.packages.selected = JSON.parse(data) || {};
      }),
      AsyncStorage.getItem("newToPackages").then(function(data) {
        Sefaria.packages.newToPackages = !!data ? JSON.parse(data) : true;
        console.log(Sefaria.packages.newToPackages);
      }),
    ]);
  },
  initCompleteLibrary: () => {
    //in the case the user upgraded from before packages, make sure he retains complete library if he has it
    if (Sefaria.packages.newToPackages) {
      const nAvailable = Sefaria.downloader.titlesAvailable().length;
      const nDownloaded = Sefaria.downloader.titlesDownloaded().length;
      const percentDownloaded = nDownloaded / nAvailable;
      console.log(percentDownloaded, nAvailable, nDownloaded);
      if (percentDownloaded > 0.95) {
        Sefaria.packages.updateSelected("COMPLETE LIBRARY", false);
      }
    }
  },
  updateSelected: (pkgName, shouldDownload=true) => {
    //anytime you select a package, make sure to set `newToPackages`
    Sefaria.packages.newToPackages = false;
    AsyncStorage.setItem("newToPackages", JSON.stringify(Sefaria.packages.newToPackages));
    if (Sefaria.packages.isSelected(pkgName)) {
      //prompt user about delete
      return new Promise((resolve, reject) => {
        AlertIOS.alert(
          strings.remove,
          strings.areYouSureDeleteDownload,
          [
            {text: strings.cancel, style: 'cancel'},
            {text: strings.delete, style: 'destructive', onPress: Sefaria.packages.deletePackage.bind(null, pkgName, resolve)}
          ]
        );
      });
    } else {
      for (let pkg of Sefaria.packages.available) {
        if (pkg.parent === pkgName || (Sefaria.packages.isFullLibrary(pkgName) && pkg.en !== pkgName)) {
          delete Sefaria.packages.selected[pkg.en];
        }
      }
      Sefaria.packages.selected[pkgName] = true;
      if (shouldDownload) {
        Sefaria.downloader.downloadLibrary(true);
      }
      return AsyncStorage.setItem("packagesSelected", JSON.stringify(Sefaria.packages.selected)).catch(function(error) {
        console.error("AsyncStorage failed to save: " + error);
      });
    }
  },
  isSelected: pkgName => {
    return !!Sefaria.packages.selected[pkgName] || Sefaria.packages.selected[pkgName] === 0;
  },
  isFullLibrary: pkgName => {
    //full library pkg has no indexes listed
    return !Sefaria.packages.available.find(p=>p.en === pkgName).indexes;
  },
  getSelectedParent: pkgName => {
    const currPkgObj = Sefaria.packages.available.find(p=>p.en === pkgName);
    for (let tempPkg of Object.keys(Sefaria.packages.selected)) {
      if (currPkgObj.parent === tempPkg || (Sefaria.packages.isFullLibrary(tempPkg) && tempPkg !== currPkgObj.en)) {
        return Sefaria.packages.available.find(p=>p.en === tempPkg);
      }
    }
    return false;
  },
  titleIsSelected: title => {
    const pkgs = Sefaria.packages.titleToPackageMap[title];
    for (pkg of Object.keys(Sefaria.packages.selected)) {
      if (Sefaria.packages.isFullLibrary(pkg)) { return true; }
    }
    if (!!pkgs) {
      for (pkg of pkgs) {
        if (Sefaria.packages.isSelected(pkg)) { return true; }
      }
    }
    return false;
  },
  titleInPackage: (title, pkg) => {
    const pkgList = Sefaria.packages.titleToPackageMap[title];
    return Sefaria.packages.isFullLibrary(pkg) || (!!pkgList && pkgList.indexOf(pkg) !== -1);
  },
  deletePackage: (pkgName, resolve) => {
    if (!resolve) { resolve = ()=>{} }
    RNFS.unlink(RNFS.DocumentDirectoryPath + "/tmp");
    RNFS.mkdir(RNFS.DocumentDirectoryPath + "/tmp");
    const dl = Sefaria.downloader;
    if (Sefaria.packages.isFullLibrary(pkgName)) {
      RNFS.unlink(RNFS.DocumentDirectoryPath + "/library");
      dl._setData("lastDownload", {});
      dl._setData("shouldDownload", false);
      dl.clearQueue();
      Sefaria.packages.finishDeletePackage(pkgName, resolve);
    } else {
      const pkgObj = Sefaria.packages.available.find(p=>p.en === pkgName);
      const reflect = promise => promise.then(v=>1,e=>e);  // make sure all promises resolve but remember which ones rejected so that Promise.all() runs
      const promises = pkgObj.indexes.map(i => reflect(RNFS.unlink(`${RNFS.DocumentDirectoryPath}/library/${i}.zip`)));
      Promise.all(promises).then((result) => {
        result.forEach((r,i)=>{
          const title = pkgObj.indexes[i]
          if (r !== 1) { console.log("Failed to delete:", title, r); }
          else {
            delete dl._data.lastDownload[title];
          }
        });
        dl._setData("lastDownload", dl._data.lastDownload);
        if (Object.keys(dl._data.lastDownload).length === 0) {
          dl._setData("shouldDownload", false);
        }
        // remove indexes from queue that are in this package
        dl._setData("downloadQueue", dl._data.downloadQueue.filter(q => pkgObj.indexes.indexOf(q) === -1));
        dl._setData("downloadInProgress", dl._data.downloadInProgress.filter(p => pkgObj.indexes.indexOf(p) === -1));
        Sefaria.packages.finishDeletePackage(pkgName, resolve);
      })
    }
    Sefaria.track.event("Downloader", "Delete Library");
  },
  finishDeletePackage(pkgName, resolve) {
    if (Sefaria.packages.isFullLibrary(pkgName)) {
      Sefaria.packages.selected = {};
    } else {
      delete Sefaria.packages.selected[pkgName];
    }
    Sefaria.downloader.onChange && Sefaria.downloader.onChange();
    AsyncStorage.setItem("packagesSelected", JSON.stringify(Sefaria.packages.selected))
    .then(resolve)
    .catch(function(error) {
      console.error("AsyncStorage failed to save: " + error);
    });
  },
  deleteActiveDownloads() {
    AlertIOS.alert(
      strings.cancel,
      strings.areYouSureDeleteDownloadProgress,
      [
        {text: strings.no, style: 'cancel'},
        {text: strings.yes, style: 'destructive', onPress: () => {
          Sefaria.packages.available.forEach(p => {
            const isSelected = Sefaria.packages.isSelected(p.en);
            const isD = Sefaria.downloader.downloading && isSelected;
            const nUpdates   = isD ? Sefaria.downloader.updatesAvailable().filter(t => Sefaria.packages.titleInPackage(t, p.en)).length : 0;
            if (isD && nUpdates > 0) {
              Sefaria.packages.deletePackage(p.en);
            }
          });
        }}
      ]
    );
  },
}

export default Packages
