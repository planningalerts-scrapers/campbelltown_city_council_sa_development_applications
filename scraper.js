let cheerio = require("cheerio");
let request = require("request");
let sqlite3 = require("sqlite3").verbose();
let pdf2json = require("pdf2json");
let urlparser = require("url");
let moment = require("moment");

const LodgedApplicationsUrl = "https://www.campbelltown.sa.gov.au/page.aspx?u=1973";
const ApprovedApplicationsUrl = "https://www.campbelltown.sa.gov.au/page.aspx?u=1777";

// Sets up an sqlite database.

function initializeDatabase(callback) {
    let database = new sqlite3.Database("data.sqlite");
    database.serialize(() => {
        database.run("create table if not exists [data] ([council_reference] text primary key, [address] text, [description] text, [info_url] text, [comment_url] text, [date_scraped] text, [date_received] text, [on_notice_from] text, [on_notice_to] text)");
        callback(database);
    });
}

// Inserts a row in the database if it does not already exist.

function insertRow(developmentApplication) {
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
    ]);
    sqlStatement.finalize();  // releases any locks
}

// Reads a page using a request.
    
function requestPage(url, callback) {
    console.log(`Requesting page: ${url}`);
    request(url, (error, response, body) => {
        if (error) {
            console.log(`Error requesting page ${url}: ${error}`);
            return;
        }
        callback(body);
    });
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
            if (!pdfUrls.some(url => url === parsedPdfUrl.href))
                pdfUrls.push(parsedPdfUrl.href);
        });
        console.log(`Found ${pdfUrls.length} PDF file(s) to read and parse at ${url}.`);

        // Read and parse each PDF, extracting the development application text.

        for (let pdfUrl of pdfUrls) {
            let pdfParser = new pdf2json();
            let pdfPipe = request({ url: pdfUrl, encoding: null }).pipe(pdfParser);
            pdfPipe.on("pdfParser_dataError", error => console.error(error))
            pdfPipe.on("pdfParser_dataReady", pdf => {
                console.log(`Parsing PDF: ${pdfUrl}`);
                let pdfRows = convertPdfToText(pdf);

                let developmentApplications = [];
                let haveApplicationNumber = false;
                let haveAddress = false;
                let applicationNumber = null;
                let address = null;
                let reason = null;
                let informationUrl = null;
                let commentUrl = null;
                let scrapeDate = moment().format("YYYY-MM-DD");
                let lodgementDate = null;

                for (let row of pdfRows) {
                    // If there are two forward slashes within the first 20 characters then it is
                    // very likely an application number (and it is not formatted as a date such
                    // as "31/12/2008").  For example, "162/0082/12".

                    if (row[0].trim().substring(0, 20).replace(/[^\/]/g, "").length === 2 && !moment(row[0].trim().substring(0, 10), "DD/MM/YYYY", true).isValid()) {
                        // Extract the development application number and lodgement date.

                        applicationNumber = row[0].trim();
                        address = null;
                        reason = null;
                        lodgementDate = moment(row[2].trim(), "D/MM/YYYY", true);  // allow the leading zero of the day to be omitted
                        haveApplicationNumber = true;
                        haveAddress = false;
                    } else if (haveApplicationNumber) {
                        // Extract the address of th development application.

                        address = row.join("").trim();
                        haveApplicationNumber = false;
                        haveAddress = true;
                    } else if (haveAddress) {
                        // Extract the reason for the development application.  This is assumed
                        // to be the end of the information for this development application.

                        reason = row.join("").trim();
                        haveApplicationNumber = false;
                        haveAddress = false;
                        developmentApplications.push({
                            applicationNumber: applicationNumber,
                            address: address,
                            reason: reason,
                            informationUrl: informationUrl,
                            commentUrl: commentUrl,
                            scrapeDate: scrapeDate,
                            lodgementDate: (lodgementDate.isValid() ? lodgementDate.format("YYYY-MM-DD") : null) });
                    }
                }

                for (let developmentApplication of developmentApplications)
                    insertRow(developmentApplication)
                    console.log(developmentApplication);
            });
        }

        readRows(database);

        // database.close();
    });
}

// Convert a parsed PDF into an array of rows.  This is based on pdf2table by Sam Decrock.
// See https://github.com/SamDecrock/pdf2table/blob/master/lib/pdf2table.js.

function convertPdfToText(pdf) {
    let comparer = (a, b) => (a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0);

    // Find the smallest Y co-ordinate for two texts with equal X co-ordinates.

    let smallestYValueForPage = [];

    for (let pageIndex = 0; pageIndex < pdf.formImage.Pages.length; pageIndex++) {
        let page = pdf.formImage.Pages[pageIndex];
        let smallestYValue = null;  // per page
        let textsWithSameXvalues = {};

        for (let textIndex = 0; textIndex < page.Texts.length; textIndex++) {
            let text = page.Texts[textIndex];
            if (!textsWithSameXvalues[text.x])
                textsWithSameXvalues[text.x] = [];
            textsWithSameXvalues[text.x].push(text);
        }

        // Find smallest Y distance.

        for (let x in textsWithSameXvalues) {
            let texts = textsWithSameXvalues[x];
            for (let i = 0; i < texts.length; i++) {
                let firstYvalue = texts[i].y;
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

                let maxYdifference = smallestYValueForPage[pageIndex];
                if (rows[rowIndex].y - maxYdifference < text.y && text.y < rows[rowIndex].y + maxYdifference) {
                    // Only add value of T to data (which is the actual text).

                    for (let index = 0; index < text.R.length; index++)
                        rows[rowIndex].data.push({ text: decodeURIComponent(text.R[index].T), x: text.x });
                    foundRow = true;
                }
            };

            if (!foundRow) {
                // Create a new row.

                let row = { y: text.y, data: [] };

                // Add text to the row.

                for (let index = 0; index < text.R.length; index++)
                    row.data.push({ text: decodeURIComponent(text.R[index].T), x: text.x });

                rows.push(row);
            }
        };

        // Sort each extracted row.

        for (let index = 0; index < rows.length; index++)
            rows[index].data.sort(comparer);

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

// Reads and parses the development application web pages.  The results are inserted into a
// database.

function run(database) {
    parsePdfs(database, LodgedApplicationsUrl);
    parsePdfs(database, ApprovedApplicationsUrl);
}

initializeDatabase(run);
