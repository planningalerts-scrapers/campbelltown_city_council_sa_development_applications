let cheerio = require("cheerio");
let request = require("request");
let sqlite3 = require("sqlite3").verbose();
let pdf2json = require("pdf2json");
let urlparser = require("url");

// Sets up an sqlite database.

function initializeDatabase(callback) {
    let database = new sqlite3.Database("data.sqlite");
    database.serialize(() => {
        database.run("create table if not exists [data] ([council_reference] text, [address] text, [description] text, [info_url] text, [comment_url] text, [date_scraped] text, [date_received] text, [on_notice_from] text, [on_notice_to] text)");
        callback(database);
    });
}

// Inserts a row into the database.

function insertRow(database, value) {
    let sqlStatement = database.prepare("insert into [data] values (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    sqlStatement.run(value);
    sqlStatement.finalize();
}

// Reads rows from the database.

function readRows(database) {
    database.each("select [rowid] as [id], [name] from [data]", (error, row) => {
        console.log(row.id + ": " + row.name);
    });
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
        console.log(`Found ${pdfUrls.length} PDF file(s) to read and parse.`);

        // Read and parse each PDF, extracting the development application text.

        for (let pdfUrl of pdfUrls) {
            let pdfParser = new pdf2json();
            let pdfPipe = request({ url: pdfUrl, encoding: null }).pipe(pdfParser);
            pdfPipe.on("pdfParser_dataError", error => console.error(error))
            pdfPipe.on("pdfParser_dataReady", pdf => {
                console.log(`Parsing PDF: ${pdfUrl}`);
                let pdfRows = convertPdfToText(pdf);
            });
        }

        readRows(database);

        // database.close();
    });
}

// Convert a parsed PDF into an array of rows.  This is based on pdf2table by Sam Decrock.
// See https://github.com/SamDecrock/pdf2table/blob/master/lib/pdf2table.js.

function convertPdfToText(pdf) {
    var comparer = (a, b) => (a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0);

    // Find the smallest y value between two texts with equal x values.

    var smallestYValueForPage = [];

    for (var pageIndex = 0; pageIndex < pdf.formImage.Pages.length; pageIndex++) {
        var page = pdf.formImage.Pages[pageIndex];
        var smallestYValue = null;  // per page
        var textsWithSameXvalues = {};

        for (var textIndex = 0; textIndex < page.Texts.length; textIndex++) {
            var text = page.Texts[textIndex];
            if(!textsWithSameXvalues[text.x])
                textsWithSameXvalues[text.x] = [];
            textsWithSameXvalues[text.x].push(text);
        }

        // Find smallest y distance.

        for (var x in textsWithSameXvalues) {
            var texts = textsWithSameXvalues[x];
            for (var i = 0; i < texts.length; i++) {
                var firstYvalue = texts[i].y;
                for (var j = 0; j < texts.length; j++) {
                    if (texts[i] !== texts[j]) {
                        var distance = Math.abs(texts[j].y - texts[i].y);
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

    // Find texts with similar y values (in the range of y - smallestYValue to y + smallestYValue).

    var myPages = [];

    for (var pageIndex = 0; pageIndex < pdf.formImage.Pages.length; pageIndex++) {
        var page = pdf.formImage.Pages[pageIndex];

        var rows = [];  // store texts and their x positions in rows

        for (var textIndex = 0; textIndex < page.Texts.length; textIndex++) {
            var text = page.Texts[textIndex];

            var foundRow = false;
            for (var rowIndex = rows.length - 1; rowIndex >= 0; rowIndex--) {
                // y value of text falls within the y-value range, add text to row.

                var maxYdifference = smallestYValueForPage[pageIndex];
                if (rows[rowIndex].y - maxYdifference < text.y && text.y < rows[rowIndex].y + maxYdifference) {
                    // Only add value of T to data (which is the actual text).

                    for (var index = 0; index < text.R.length; index++)
                        rows[rowIndex].data.push({ text: decodeURIComponent(text.R[index].T), x: text.x });
                    foundRow = true;
                }
            };

            if (!foundRow) {
                // Create a new row.

                var row = { y: text.y, data: [] };

                // Add text to the row.

                for (var index = 0; index < text.R.length; index++)
                    row.data.push({ text: decodeURIComponent(text.R[index].T), x: text.x });

                rows.push(row);
            }
        };

        // Sort each extracted row.

        for (var index = 0; index < rows.length; index++)
            rows[index].data.sort(comparer);

        // Add rows to pages.

        myPages.push(rows);
    };

    // Flatten pages into rows.

    var rows = [];

    for (var pageIndex = 0; pageIndex < myPages.length; pageIndex++) {
        for (var rowIndex = 0; rowIndex < myPages[pageIndex].length; rowIndex++) {
            // Now that each row is made of objects extract the text property from the object.

            var rowEntries = []
            var row = myPages[pageIndex][rowIndex].data;
            for (var index = 0; index < row.length; index++)
                rowEntries.push(row[index].text);

            // Append the extracted and ordered text into the return rows.

            rows.push(rowEntries);
        };
    };

    return rows;
}

// Reads and parses the development application web pages.

function run(database) {
    parsePdfs(database, "https://www.campbelltown.sa.gov.au/page.aspx?u=1973");  // lodged applications
    parsePdfs(database, "https://www.campbelltown.sa.gov.au/page.aspx?u=1777");  // approved applications
}

initializeDatabase(run);
