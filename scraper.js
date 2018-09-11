// Parses the lodged development application PDF files found at the South Australian Campbelltown
// City Council web site and places them in a database.
//
// Michael Bone
// 24th June 2018

let cheerio = require("cheerio");
let request = require("request");
let sqlite3 = require("sqlite3").verbose();
let pdf2json = require("pdf2json");
let urlparser = require("url");
let moment = require("moment");

const LodgedApplicationsUrl = "http://www.campbelltown.sa.gov.au/page.aspx?u=1973";
const CommentUrl = "mailto:mail@campbelltown.sa.gov.au";

// Sets up an sqlite database.

function initializeDatabase(callback) {
    let database = new sqlite3.Database("data.sqlite");
    database.serialize(() => {
        database.run("create table if not exists [data] ([council_reference] text primary key, [address] text, [description] text, [info_url] text, [comment_url] text, [date_scraped] text, [date_received] text, [on_notice_from] text, [on_notice_to] text)");
        callback(database);
    });
}

// Inserts a row in the database if it does not already exist.

function insertRow(database, pdfFileName, developmentApplication) {
    let sqlStatement = database.prepare("insert or ignore into [data] values (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    sqlStatement.run([
        developmentApplication.applicationNumber,
        developmentApplication.address,
        developmentApplication.reason,
        developmentApplication.informationUrl,
        developmentApplication.commentUrl,
        developmentApplication.scrapeDate,
        developmentApplication.lodgementDate,
        null,
        null
    ], function(error, row) {
        if (error)
            console.log(error);
        else {
            if (this.changes > 0)
                console.log(`    Inserted new application \"${developmentApplication.applicationNumber}\" from \"${pdfFileName}\" into the database.`);
            sqlStatement.finalize();  // releases any locks
        }
    });
}

// Reads a page using a request.
    
function requestPage(url, callback) {
    console.log(`Requesting page: ${url}`);
    request(url, (error, response, body) => {
        if (error)
            console.log(`Error requesting page ${url}: ${error}`);
        else
            callback(body);
    });
}

// Gets a random integer in the specified range: [minimum, maximum).

function getRandom(minimum, maximum) {
    return Math.floor(Math.random() * (Math.floor(maximum) - Math.ceil(minimum))) + Math.ceil(minimum);
}

// Parses all PDF files found at the specified URL.

function parsePdfs(database, url) {
    let parsedUrl = new urlparser.URL(url);
    let baseUrl = parsedUrl.origin + parsedUrl.pathname;

    requestPage(url, body => {
        // Use cheerio to find all URLs that refer to PDFs.
 
        let pdfUrls = [];
        let $ = cheerio.load(body);
        $("div.uContentList a").each((index, element) => {
            let parsedPdfUrl = new urlparser.URL(element.attribs.href, baseUrl);
            if (!pdfUrls.some(url => url === parsedPdfUrl.href))  // avoid duplicates
                pdfUrls.push(parsedPdfUrl.href);
        });
        console.log(`Found ${pdfUrls.length} PDF file(s) to download and parse at ${url}.  Selecting two to parse.`);

        // Select the most recent PDF.  And randomly select one other PDF (avoid processing all
        // PDFs at once because this may use too much memory, resulting in morph.io terminating
        // the current process).

        let selectedPdfUrls = [];
        selectedPdfUrls.push(pdfUrls.shift());
        if (pdfUrls.length > 0)
            selectedPdfUrls.push(pdfUrls[getRandom(1, pdfUrls.length)]);

        // Read and parse each PDF, extracting the development application text.

        for (let pdfUrl of selectedPdfUrls) {
            // Parse the PDF into a collection of PDF rows.  Each PDF row is simply an array of
            // strings, being the text that has been parsed from the PDF.

            let pdfParser = new pdf2json();
            request({ url: pdfUrl, encoding: null }).pipe(pdfParser);
            pdfParser.on("pdfParser_dataError", error => { console.error(error); });
            pdfParser.on("error", () => { });
            pdfParser.on("finish", () => { });
            pdfParser.on("pdfParser_dataReady", pdf => {
                // Convert the JSON representation of the PDF into a collection of PDF rows.

                console.log(`Parsing PDF: ${pdfUrl}`);
                let pdfRows = convertPdfToText(pdf);

                let developmentApplications = [];
                let haveApplicationNumber = false;
                let haveAddress = false;
                let applicationNumber = null;
                let address = null;
                let reason = null;
                let informationUrl = pdfUrl;
                let commentUrl = CommentUrl;
                let scrapeDate = moment().format("YYYY-MM-DD");
                let lodgementDate = null;

                let previousPdfRow = null;
                for (let pdfRow of pdfRows) {
                    // Ignore the lines associated with a page break (that is, ignore the header
                    // and footer text that appears at the top and bottom of every page).

                    let line = pdfRow.join("").replace(/\s/g, "").toLowerCase();
                    if (line.startsWith("publicregisterofdevelopmentapplications") ||
                        line.startsWith("lodgementdatefrom") ||
                        line.startsWith("lodgementdateto") ||
                        line.startsWith("monday,") ||
                        line.startsWith("tuesday,") ||
                        line.startsWith("wednesday,") ||
                        line.startsWith("thursday,") ||
                        line.startsWith("friday,") ||
                        line.startsWith("saturday,") ||
                        line.startsWith("sunday,"))
                        continue;

                    // If there are two forward slashes within the first 20 characters then it is
                    // very likely an application number (and it is not formatted as a date such
                    // as "31/12/2008").  For example, "162/0082/12".
                    //
                    // Note that sometimes the lodgement date will be difficult to correctly
                    // obtain.  For example, if the date is split across two elements in a PDF
                    // row:
                    //
                    //     ["26/10/2017", "02/", "11/2017", "Allot 1 DP ..."]
                    //
                    // The parseLodgementDate function makes an effort to resolve this situation.
                    
                    let parsedApplicationNumber = parseApplicationNumber(pdfRow);
                    if (parsedApplicationNumber !== null) {
                        // Extract the development application number and lodgement date.

                        applicationNumber = parsedApplicationNumber;
                        address = null;
                        reason = null;
                        lodgementDate = parseLodgementDate(pdfRow, 2, "nnn/nnnn/nn".length);  // dates appear after the application number
                        haveApplicationNumber = true;
                        haveAddress = false;
                    } else if (haveApplicationNumber && !haveAddress) {
                        // Attempt to extract the lodgement date (if it was not found earlier).

                        if (lodgementDate === null)
                            lodgementDate = parseLodgementDate(pdfRow, 1, 0);

                        // Extract the address of the development application.  It is assumed to
                        // always appear on the next line after the text "Property Address"
                        // (ignoring any header or footer text).

                        if (previousPdfRow !== null && previousPdfRow.join("").replace(/\s/g, "").toLowerCase().startsWith("propertyaddress")) {
                            address = pdfRow.join("").trim();
                            haveApplicationNumber = true;
                            haveAddress = true;
                        }
                    } else if (haveApplicationNumber && haveAddress) {
                        // Extract the reason for the development application.  It is assumed to
                        // always appear on the next line after the text "Nature of Development"
                        // (ignoring any header or footer text).

                        if (previousPdfRow !== null && previousPdfRow.join("").replace(/\s/g, "").toLowerCase().startsWith("natureofdevelopment")) {
                            reason = pdfRow.join("").trim();
                            developmentApplications.push({
                                applicationNumber: applicationNumber,
                                address: address,
                                reason: reason,
                                informationUrl: informationUrl,
                                commentUrl: commentUrl,
                                scrapeDate: scrapeDate,
                                lodgementDate: ((lodgementDate === null) ? null : lodgementDate.format("YYYY-MM-DD")) });
                            haveApplicationNumber = false;
                            haveAddress = false;
                        }
                    }
                    previousPdfRow = pdfRow;
                }

                // Insert all the development applications that were found into the database as
                // rows in a table.  If the same development application number already exists on
                // a row then that existing row will not be replaced.

                let pdfFileName = decodeURIComponent(new urlparser.URL(pdfUrl).pathname.split("/").pop());
                console.log(`Found ${developmentApplications.length} development application(s) in \"${pdfFileName}\".`)
                for (let developmentApplication of developmentApplications)
                    insertRow(database, pdfFileName, developmentApplication);
            });
        }
    });
}

// Parses an application number from the specified PDF row of text.

function parseApplicationNumber(pdfRow) {
    // Assume a strict format of "nnn/nnnn/nn" for the application number to avoid any confusion
    // with dates (which are similarly formatted).  For example, "170/1318/14".

    let text = pdfRow.join("").trim().substring(0, "nnn/nnnn/nn".length);
    return /^[0-9][0-9][0-9]\/[0-9][0-9][0-9][0-9]\/[0-9][0-9]$/.test(text) ? text : null;
}

// Parses a lodgement date from the specified PDF row of text.

function parseLodgementDate(pdfRow, columnIndex, characterIndex) {
    // For example,
    //
    // [ "170/0298/18", "07/11/2017", "06/04/2018", "Allot 4 D", "P ..." ]

    let lodgementDate = null;
    if (pdfRow.length >= 3) {
        lodgementDate = moment(pdfRow[columnIndex].trim(), "D/MM/YYYY", true);  // allows the leading zero of the day to be omitted
        if (lodgementDate.isValid())
            return lodgementDate;
    }

    // For example,
    //
    // [ "170/0298/18", "07/", "11/2017", "06/04/2018", "Allot 4 D", "P ..." ]
    // [ "2", "0/11/2017", "20/11/2017", "ALLOT 100 FP ..." ]

    let text = pdfRow.join("").substring(characterIndex);  // for example, "07/11/201706/04/2018Allot 4 DP ..."
    text = text.substring("DD/MM/YYYY".length, "DD/MM/YYYY".length + "DD/MM/YYYY".length);  // this assumes the leading zero of the day has not been omitted
    lodgementDate = moment(text, "DD/MM/YYYY", true);
    return lodgementDate.isValid() ? lodgementDate : null;
}

// Convert a parsed PDF into an array of rows.  This function is based on pdf2table by Sam Decrock.
// See https://github.com/SamDecrock/pdf2table/blob/master/lib/pdf2table.js.
//
// Copyright (c) 2015 Sam Decrock <sam.decrock@gmail.com>
//
// MIT License
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

function convertPdfToText(pdf) {
    let xComparer = (a, b) => (a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0);
    let yComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : 0);

    // Find the smallest Y co-ordinate for two texts with equal X co-ordinates.

    let smallestYValueForPage = [];

    for (let pageIndex = 0; pageIndex < pdf.formImage.Pages.length; pageIndex++) {
        let page = pdf.formImage.Pages[pageIndex];
        let smallestYValue = null;  // per page
        let textsWithSameXValues = {};

        for (let textIndex = 0; textIndex < page.Texts.length; textIndex++) {
            let text = page.Texts[textIndex];
            if (!textsWithSameXValues[text.x])
                textsWithSameXValues[text.x] = [];
            textsWithSameXValues[text.x].push(text);
        }

        // Find smallest Y distance.

        for (let x in textsWithSameXValues) {
            let texts = textsWithSameXValues[x];
            for (let i = 0; i < texts.length; i++) {
                for (let j = 0; j < texts.length; j++) {
                    if (texts[i] !== texts[j]) {
                        let distance = Math.abs(texts[j].y - texts[i].y);
                        if (smallestYValue === null || distance < smallestYValue)
                            smallestYValue = distance;
                    }
                };
            };
        }

        if (smallestYValue === null)
            smallestYValue = 0;
        smallestYValueForPage.push(smallestYValue);
    }

    // Find texts with similar Y values (in the range of Y - smallestYValue to Y + smallestYValue).

    let myPages = [];

    for (let pageIndex = 0; pageIndex < pdf.formImage.Pages.length; pageIndex++) {
        let page = pdf.formImage.Pages[pageIndex];

        let rows = [];  // store texts and their X positions in rows

        for (let textIndex = 0; textIndex < page.Texts.length; textIndex++) {
            let text = page.Texts[textIndex];

            let foundRow = false;
            for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex--) {
                // Y value of text falls within the Y value range, add text to row.

                let maximumYdifference = smallestYValueForPage[pageIndex];
                if (rows[rowIndex].y - maximumYdifference < text.y && text.y < rows[rowIndex].y + maximumYdifference) {
                    // Only add value of T to data (which is the actual text).

                    for (let index = 0; index < text.R.length; index++)
                        rows[rowIndex].data.push({ text: decodeURIComponent(text.R[index].T), x: text.x });
                    foundRow = true;
                }
            };

            // Create a new row and add the text to the row.

            if (!foundRow) {
                let row = { y: text.y, data: [] };
                for (let index = 0; index < text.R.length; index++)
                    row.data.push({ text: decodeURIComponent(text.R[index].T), x: text.x });
                rows.push(row);
            }
        };

        // Sort each extracted row horizontally by X co-ordinate.

        for (let index = 0; index < rows.length; index++)
            rows[index].data.sort(xComparer);

        // Sort rows vertically by Y co-ordinate.

        rows.sort(yComparer);

        // Add rows to pages.

        myPages.push(rows);
    };

    // Flatten pages into rows.

    let rows = [];

    for (let pageIndex = 0; pageIndex < myPages.length; pageIndex++) {
        for (let rowIndex = 0; rowIndex < myPages[pageIndex].length; rowIndex++) {
            // Now that each row is made of objects extract the text property from the object.

            let rowEntries = []
            let row = myPages[pageIndex][rowIndex].data;
            for (let index = 0; index < row.length; index++)
                rowEntries.push(row[index].text);

            // Append the extracted and ordered text into the return rows.

            rows.push(rowEntries);
        };
    };

    return rows;
}

// Reads and parses the development application web page.  The results are inserted into a
// database.

function run(database) {
    parsePdfs(database, LodgedApplicationsUrl);
}

initializeDatabase(run);
