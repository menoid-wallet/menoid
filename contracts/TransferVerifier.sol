// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract Groth16Verifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 7419031735121079373805748615251420514952468436681738889693999025501925296379;
    uint256 constant deltax2 = 4082898933468885915153010684741096806599977170464591985397068958174125738285;
    uint256 constant deltay1 = 18157327767020664322172485528359729546306819211583055666233328463866663916912;
    uint256 constant deltay2 = 16528876166234811460287140262827131311303196759401576361384106157449179739966;

    
    uint256 constant IC0x = 17107109497308268306123078319832511824375802363834173211559575587272301200222;
    uint256 constant IC0y = 5553811048915111039031215969064692194636193673248779811895946309552336618559;
    
    uint256 constant IC1x = 7351330212226946041041005596162128044669478027185139720074977378355720529877;
    uint256 constant IC1y = 9812276631308813515490906624900381669271349348381273070558684232522479594900;
    
    uint256 constant IC2x = 19682001252830812134040103479827222878751117048441591899147869171044161161618;
    uint256 constant IC2y = 13807249544769710079908904131298048436279110043563307432645848046114798387317;
    
    uint256 constant IC3x = 20653687773119752161308081300463519762749877863012964063614187763387884615407;
    uint256 constant IC3y = 15190496788045583752250380303147820650076867185412752069451744620446668275703;
    
    uint256 constant IC4x = 10191726992514024007673606885243083993840155130371214554208980123718426481397;
    uint256 constant IC4y = 5311953314158103004457292699270337869065559843033434637049883801727723109811;
    
    uint256 constant IC5x = 17095690150489291740871575221785959413836260024965990780240478914777711936313;
    uint256 constant IC5y = 20104530375624890489500220237043965461816208326528502701337402783343767496667;
    
    uint256 constant IC6x = 8220598382962777505759434777282600354181390765127985928055893168272804291671;
    uint256 constant IC6y = 9173638095406892728490966483305071136690523922320711844130034103673423873458;
    
    uint256 constant IC7x = 17486474878355197158820074787773434883884546389519541149455875458142358806312;
    uint256 constant IC7y = 15644587986136534567084234832480996991056318146253438166900176700785782660282;
    
    uint256 constant IC8x = 13824448296971917062676102968575939140809413118109452862964578147831841646688;
    uint256 constant IC8y = 2042937169209873447914035464078955589818167228241840687603587746624293418889;
    
    uint256 constant IC9x = 2000387472806411771152900486134590938641718661752562017163682632741730413715;
    uint256 constant IC9y = 20674064333987215319683688572438043995573115383937880905177004358607717696841;
    
    uint256 constant IC10x = 21827005738761136517611002394981594539427537475468860329175122494420202117307;
    uint256 constant IC10y = 14224253931180729451967083526367491156097703135310774174510186344237523248965;
    
    uint256 constant IC11x = 437392052867805765327333163360949698305120699369153817832924180718936251136;
    uint256 constant IC11y = 18438025390090507925375706776825872473716622886477963197001699174428899023506;
    
    uint256 constant IC12x = 21659356268118977381730257518340091085928841120915002391489851254765437046857;
    uint256 constant IC12y = 21265711524688378487757648521867157201120248953670548434339513888620688664912;
    
    uint256 constant IC13x = 3429387849587408637195938853565102638584015358004713261037203358348288128862;
    uint256 constant IC13y = 18973824431754310091509268872323701664212543476951132319278886585539416134466;
    
    uint256 constant IC14x = 8865005437112337788769746149311841259918408415450999718027688148775484945488;
    uint256 constant IC14y = 8273485444012612693937156504468908257408203394953600761928973044013070938898;
    
    uint256 constant IC15x = 16226930738685930372813015205995964371590160477091604437326253309784785897178;
    uint256 constant IC15y = 21666043584597406212364289476205377723978521171359554185189039612213383712919;
    
    uint256 constant IC16x = 16464168180372251530868972555865938477492430608056515452980820989177836392726;
    uint256 constant IC16y = 12775872496442936618798022677854931859863823364391096936334371821143857364759;
    
    uint256 constant IC17x = 12575615835859482470060827060951997632324921657200988538972965936622256602687;
    uint256 constant IC17y = 8397564930321529080856970109330317867128896170927679145101352108582501845467;
    
    uint256 constant IC18x = 11483553005579316886492595182824101356713366985403999135583597997812332087165;
    uint256 constant IC18y = 16196719461740425846743370187662214433691390331485378391851810506974847675721;
    
    uint256 constant IC19x = 13943612196038727143803119028169710997222101238158305880427290685608487721826;
    uint256 constant IC19y = 6941202502232694995838601140809461857227370832051035913127293114561184196799;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[19] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                
                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))
                
                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))
                
                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))
                
                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))
                
                g1_mulAccC(_pVk, IC19x, IC19y, calldataload(add(pubSignals, 576)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            
            checkField(calldataload(add(_pubSignals, 448)))
            
            checkField(calldataload(add(_pubSignals, 480)))
            
            checkField(calldataload(add(_pubSignals, 512)))
            
            checkField(calldataload(add(_pubSignals, 544)))
            
            checkField(calldataload(add(_pubSignals, 576)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
