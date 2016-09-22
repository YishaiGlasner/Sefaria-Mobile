'use strict';

import React, { Component } from 'react';
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Image,
  ListView,
  Modal
} from 'react-native';

var ReaderDisplayOptionsMenu  = require('./ReaderDisplayOptionsMenu');
var ReaderNavigationMenu      = require('./ReaderNavigationMenu');
var ReaderTextTableOfContents = require('./ReaderTextTableOfContents');
var SearchPage                = require('./SearchPage');
var TextColumn                = require('./TextColumn');
var TextList                  = require('./TextList');
var styles                    = require('./Styles.js');

var {
  MenuButton,
  DisplaySettingsButton,
  LoadingView,
  CategoryColorLine
} = require('./Misc.js');


var ReaderPanel = React.createClass({
  propTypes: {
    segmentRef:    React.PropTypes.number,
    offsetRef:     React.PropTypes.string,
    data:          React.PropTypes.array,
    textTitle:     React.PropTypes.string,
    heTitle:       React.PropTypes.string,
    heRef:         React.PropTypes.string,
    openRef:       React.PropTypes.func.isRequired,
    openNav:       React.PropTypes.func.isRequired,
    openTextToc:   React.PropTypes.func.isRequired,
    interfaceLang: React.PropTypes.string.isRequired,
    loading:       React.PropTypes.bool,
    openLinkCat:   React.PropTypes.func.isRequired,
    closeLinkCat:  React.PropTypes.func.isRequired,
    updateLinkCat: React.PropTypes.func.isRequired,
    onLinkLoad:    React.PropTypes.func.isRequired,
    filterIndex:   React.PropTypes.number,
    linkRecentFilters: React.PropTypes.array,
    linkSummary:   React.PropTypes.array,
    linkContents:  React.PropTypes.array,
    setTheme:      React.PropTypes.func.isRequired,
    theme:         React.PropTypes.object,
    themeStr:      React.PropTypes.oneOf(["white","grey","black"]),
    Sefaria:       React.PropTypes.object.isRequired
  },
  getInitialState: function () {
    Sefaria = this.props.Sefaria;
    return {
    	textFlow: this.props.textFlow || 'segmented', 	// alternative is 'continuous'
    	columnLanguage: this.props.columnLanguage || 'english', 	// alternative is 'hebrew' &  'bilingual'
      searchQuery: '',
      isQueryRunning: false,
      isQueryLoadingTail: false,
      isNewSearch: false,
      currSearchPage: 0,
      settings: {
        language:      "bilingual",
        layoutDefault: "segmented",
        layoutTalmud:  "continuous",
        layoutTanakh:  "segmented",
        color:         "light",
        fontSize:      20,
      },
      ReaderDisplayOptionsMenuVisible: false

    };
  },
  toggleReaderDisplayOptionsMenu: function () {
    if (this.state.ReaderDisplayOptionsMenuVisible == false) {
  	 this.setState({ReaderDisplayOptionsMenuVisible:  true})
  	} else {
  	 this.setState({ReaderDisplayOptionsMenuVisible:  false})}

      console.log(this.state.ReaderDisplayOptionsMenuVisible);
  },
  onQueryChange: function(query,resetQuery) {
    var newSearchPage = 0;
    if (!resetQuery)
      newSearchPage = this.state.currSearchPage+1;


    //var req = JSON.stringify(Sefaria.search.get_query_object(query,false,[],20,20*newSearchPage,"text"));

    var query_props = {
      query: query,
      size: 20,
      from: 20*newSearchPage,
      type: "text",
      get_filters: false,
      applied_filters: []
    }
    Sefaria.search.execute_query(query_props)
    .then((responseJson) => {
      var resultArray = resetQuery ? responseJson["hits"]["hits"] : this.state.searchQueryResult.concat(responseJson["hits"]["hits"]);
      //console.log("resultArray",resultArray);
      var numResults = responseJson["hits"]["total"]
      this.setState({isQueryLoadingTail: false, isQueryRunning: false, searchQueryResult:resultArray, numSearchResults: numResults});
    })
    .catch((error) => {
      console.log(error);
      //TODO: add hasError boolean to state
      this.setState({isQueryLoadingTail: false, isQueryRunning: false, searchQueryResult:[], numSearchResults: 0});
    });

    this.setState({searchQuery:query, currSearchPage: newSearchPage, isQueryRunning: true});
  },
  setLoadQueryTail: function(isLoading) {
    this.setState({isQueryLoadingTail: isLoading});
    if (isLoading) {
      this.onQueryChange(this.state.searchQuery,false);
    }
  },
  setIsNewSearch: function(isNewSearch) {
    this.setState({isNewSearch: isNewSearch});
  },
  search: function(query) {
    this.onQueryChange(query,true);
    this.props.openSearch();
  },
  toggleLanguage: function() {
    // Toggle current display language between english/hebrew only
    if (this.state.settings.language !== "hebrew") {
      this.state.settings.language = "hebrew";
    } else {
      this.state.settings.language = "english";
    }
    this.setState({settings: this.state.settings});
  },
  setTextFlow: function(textFlow) {
    this.setState({textFlow: textFlow});

    if (textFlow == "continuous" && this.state.columnLanguage == "bilingual") {
      this.setColumnLanguage("hebrew");
    }
    this.toggleReaderDisplayOptionsMenu();
  },
  setColumnLanguage: function(columnLanguage) {
    this.setState({columnLanguage: columnLanguage});
    if (columnLanguage == "bilingual" && this.state.textFlow == "continuous") {
      this.setTextFlow("segmented");
    }
    this.toggleReaderDisplayOptionsMenu();
  },
  incrementFont: function(incrementString) {
    if (incrementString == "incrementFont") {
      this.state.settings.fontSize = this.state.settings.fontSize+1;
      this.setState({settings:this.state.settings});
    } else /*if (incrementString == "decrementFont") */{
      this.state.settings.fontSize = this.state.settings.fontSize-1;
      this.setState({settings:this.state.settings});
    }
  },
  render: function() {

    switch(this.props.menuOpen) {
      case (null):
        break;
      case ("navigation"):
        return (
          this.props.loading ?
          <LoadingView theme={this.props.theme} /> :
          <ReaderNavigationMenu
            categories={this.props.navigationCategories}
            setCategories={this.props.setNavigationCategories}
            openRef={this.props.openRef}
            openNav={this.props.openNav}
            closeNav={this.props.closeMenu}
            openSearch={this.search}
            setIsNewSearch={this.setIsNewSearch}
            toggleLanguage={this.toggleLanguage}
            settings={this.state.settings}
            interfaceLang={this.props.interfaceLang}
            theme={this.props.theme}
            Sefaria={Sefaria} />);
        break;
      case ("text toc"):
        return (
          <ReaderTextTableOfContents
            theme={this.props.theme}
            title={this.props.textTitle}
            contentLang={this.state.settings.language == "hebrew" ? "hebrew" : "english"}
            interfaceLang={this.props.interfaceLang}
            close={this.props.closeMenu}
            openRef={this.props.openRef}
            toggleLanguage={this.toggleLanguage}
            Sefaria={Sefaria} />);
        break;
      case ("search"):
        return(
          <SearchPage
            theme={this.props.theme}
            closeNav={this.props.closeMenu}
            onQueryChange={this.onQueryChange}
            openRef={this.props.openRef}
            setLoadTail={this.setLoadQueryTail}
            setIsNewSearch={this.setIsNewSearch}
            query={this.state.searchQuery}
            loadingQuery={this.state.isQueryRunning}
            isNewSearch={this.state.isNewSearch}
            loadingTail={this.state.isQueryLoadingTail}
            queryResult={this.state.searchQueryResult}
            numResults={this.state.numSearchResults} />);
        break;
    }

    return (
  		<View style={styles.container}>
          <CategoryColorLine category={Sefaria.categoryForTitle(this.props.textTitle)} />
          <ReaderControls
            theme={this.props.theme}
            title={this.state.columnLanguage == "hebrew" ? this.props.heRef : this.props.textReference}
            openNav={this.props.openNav}
            openTextToc={this.props.openTextToc}
            toggleReaderDisplayOptionsMenu={this.toggleReaderDisplayOptionsMenu} />

          { this.props.loading ?
          <LoadingView theme={this.props.theme}/> :
          <View style={[styles.mainTextPanel, this.props.theme.mainTextPanel]}>
            <TextColumn
              theme={this.props.theme}
              settings={this.state.settings}
              data={this.props.data}
              textReference={this.props.textReference}
              sectionArray={this.props.sectionArray}
              sectionHeArray={this.props.sectionHeArray}
              offsetRef={this.props.offsetRef}
              segmentIndexRef={this.props.segmentIndexRef}
              textFlow={this.state.textFlow}
              columnLanguage={this.state.columnLanguage}
              updateData={this.props.updateData}
              updateTitle={this.props.updateTitle}
              textTitle={this.props.textTitle}
              heTitle={this.props.heTitle}
              heRef={this.props.heRef}
              textSegmentPressed={ this.props.textSegmentPressed }
              textListVisible={this.props.textListVisible}
              next={this.props.next}
              prev={this.props.prev}
              loadingTextTail={this.props.loadingTextTail}
              setLoadTextTail={this.props.setLoadTextTail}
              style={styles.textColumn} />
          </View> }

          {this.state.ReaderDisplayOptionsMenuVisible ?
          (<ReaderDisplayOptionsMenu
            theme={this.props.theme}
            textFlow={this.state.textFlow}
            textReference={this.props.textReference}
            columnLanguage={this.state.columnLanguage}
            setTextFlow={this.setTextFlow}
            setColumnLanguage={this.setColumnLanguage}
            incrementFont={this.incrementFont}
            setTheme={this.props.setTheme}
            themeStr={this.props.themeStr}/>) : null }

          {this.props.textListVisible && !this.props.loading ?
            <View style={[styles.commentaryTextPanel, this.props.theme.commentaryTextPanel]}>
              <TextList
                Sefaria={Sefaria}
                settings={this.state.settings}
                theme={this.props.theme}
                segmentIndexRef={this.props.segmentIndexRef}
                textFlow={this.state.textFlow}
                columnLanguage={this.state.columnLanguage}
                openRef={ this.props.openRef }
                openCat={this.props.openLinkCat}
                closeCat={this.props.closeLinkCat}
                updateCat={this.props.updateLinkCat}
                loadLinkContent={this.props.loadLinkContent}
                onLinkLoad={this.props.onLinkLoad}
                linkSummary={this.props.linkSummary}
                linkContents={this.props.linkContents}
                filterIndex={this.props.filterIndex}
                recentFilters={this.props.linkRecentFilters} />
            </View> : null}
        </View>);
  }
});


var ReaderControls = React.createClass({
  propTypes: {
    theme:                           React.PropTypes.object,
    title:                           React.PropTypes.string,
    openNav:                         React.PropTypes.func,
    openTextToc:                     React.PropTypes.func,
    toggleReaderDisplayOptionsMenu:  React.PropTypes.func,
  },
  render: function() {
    return (
        <View style={[styles.header, this.props.theme.header]}>
          <MenuButton onPress={this.props.openNav} theme={this.props.theme}/>
          <TouchableOpacity style={styles.headerTextTitle} onPress={this.props.openTextToc}>
            <Text style={this.props.theme.text}>
              {this.props.title}
            </Text>
          </TouchableOpacity>
          <DisplaySettingsButton onPress={this.props.toggleReaderDisplayOptionsMenu} />
        </View>
    );
  }
});

module.exports = ReaderPanel;
